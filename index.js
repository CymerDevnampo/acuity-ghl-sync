require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CONFIG ─────────────────────────────────────────────────────────────────
const ACUITY_USER_ID = process.env.ACUITY_USER_ID || '';
const ACUITY_API_KEY = process.env.ACUITY_API_KEY || '';
const GHL_API_TOKEN = process.env.GHL_API_TOKEN || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '`';
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const SERVER_URL = process.env.SERVER_URL || 'http://YOUR_SERVER';

// ── COLOR → STATUS MAPPING ─────────────────────────────────────────────────
// Acuity label colors → GHL pipeline stage names
const COLOR_TO_STATUS = {
  'orange': 'Follow-up',
  'blue': 'Invoice Sent',
  'yellow': 'Rescheduled',
  'red': 'No Show',
  'green': 'Completed',
  'gray': 'In Progress',
  'violet': 'Closed',
};

// GHL API base
const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    'Authorization': `Bearer ${GHL_API_TOKEN}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json',
  },
});

// Acuity API base
const acuity = axios.create({
  baseURL: 'https://acuityscheduling.com/api/v1',
  auth: { username: ACUITY_USER_ID, password: ACUITY_API_KEY },
});

// ── CACHE: pipeline stages ─────────────────────────────────────────────────
let pipelineCache = null; // { pipelineId, stages: { 'No Show': stageId, ... } }

async function getPipelineStages() {
  if (pipelineCache) return pipelineCache;

  const res = await ghl.get(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
  const pipelines = res.data.pipelines || [];

  if (!pipelines.length) throw new Error('No pipelines found in GHL');

  // Target specific pipeline by name
  const PIPELINE_NAME = process.env.PIPELINE_NAME || 'Acuity Sync Test';
  const pipeline = pipelines.find(p => p.name.startsWith(PIPELINE_NAME)) || pipelines[0];
  console.log('📋 Using pipeline:', pipeline.name);

  const stages = {};
  for (const stage of pipeline.stages) {
    stages[stage.name] = stage.id;
    console.log(`   Stage: "${stage.name}" → ${stage.id}`);
  }

  pipelineCache = { pipelineId: pipeline.id, stages };
  return pipelineCache;
}

// ── FIND GHL CONTACT BY EMAIL ──────────────────────────────────────────────
async function findContactByEmail(email) {
  const res = await ghl.get(`/contacts/?locationId=${GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`);
  const contacts = res.data.contacts || [];
  return contacts[0] || null;
}

// ── FIND OR CREATE OPPORTUNITY FOR CONTACT ─────────────────────────────────
async function findOpportunityByContact(contactId, pipelineId) {
  const res = await ghl.get(`/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}`);
  const opps = res.data.opportunities || [];
  // Find opportunity in our pipeline
  return opps.find(o => o.pipelineId === pipelineId) || null;
}

// ── MOVE OPPORTUNITY TO STAGE ──────────────────────────────────────────────
async function moveOpportunityToStage(opportunityId, pipelineId, stageId) {
  await ghl.put(`/opportunities/${opportunityId}`, {
    pipelineId,
    pipelineStageId: stageId,
  });
}

// ── CREATE OPPORTUNITY IF NOT EXISTS ──────────────────────────────────────
async function createOpportunity(contact, pipelineId, stageId, appointmentName) {
  const res = await ghl.post('/opportunities/', {
    pipelineId,
    locationId: GHL_LOCATION_ID,
    name: appointmentName || `${contact.firstName} ${contact.lastName}`,
    pipelineStageId: stageId,
    status: 'open',
    contactId: contact.id,
  });
  return res.data.opportunity;
}

// ── MAIN WEBHOOK HANDLER ───────────────────────────────────────────────────
app.post('/webhook/acuity', async (req, res) => {
  try {
    const { action, id } = req.body;
    console.log(`\n🔔 Acuity webhook: action=${action}, id=${id}`);

    // We care about appointment changes (reschedule, cancel, change = label change)
    // Acuity sends short action names: 'scheduled', 'rescheduled', 'changed', 'canceled'
    const normalizedAction = action.replace('appointment.', '');
    if (!['scheduled', 'rescheduled', 'changed', 'canceled'].includes(normalizedAction)) {
      return res.json({ status: 'ignored', reason: 'unhandled action' });
    }

    // Fetch full appointment from Acuity
    const apptRes = await acuity.get(`/appointments/${id}`);
    const appt = apptRes.data;
    console.log(`📅 Appointment: ${appt.firstName} ${appt.lastName} <${appt.email}>`);
    console.log(`   Label color: ${appt.labelColor || 'none'}`);

    // Map label color to GHL status
    const color = appt.labelColor?.toLowerCase();
    const statusName = COLOR_TO_STATUS[color];

    if (!statusName) {
      console.log(`   ⚠️  No mapping for color "${color}" — skipping`);
      return res.json({ status: 'ignored', reason: `no mapping for color: ${color}` });
    }

    console.log(`   ✅ Mapped to GHL stage: "${statusName}"`);

    // Get pipeline stages
    const { pipelineId, stages } = await getPipelineStages();
    const stageId = stages[statusName];

    if (!stageId) {
      console.log(`   ❌ Stage "${statusName}" not found in GHL pipeline`);
      console.log(`   Available stages:`, Object.keys(stages));
      return res.status(400).json({ error: `Stage "${statusName}" not found. Available: ${Object.keys(stages).join(', ')}` });
    }

    // Find contact in GHL by email
    const contact = await findContactByEmail(appt.email);
    if (!contact) {
      console.log(`   ❌ Contact not found in GHL for email: ${appt.email}`);
      return res.status(404).json({ error: `Contact not found: ${appt.email}` });
    }

    console.log(`   👤 Found GHL contact: ${contact.id}`);

    // Find existing opportunity
    let opportunity = await findOpportunityByContact(contact.id, pipelineId);

    if (opportunity) {
      // Move to new stage
      await moveOpportunityToStage(opportunity.id, pipelineId, stageId);
      console.log(`   🚀 Moved opportunity to "${statusName}"`);
    } else {
      // Create new opportunity in the right stage
      opportunity = await createOpportunity(contact, pipelineId, stageId, appt.type);
      console.log(`   ✨ Created new opportunity in "${statusName}"`);
    }

    return res.json({
      status: 'success',
      contact: `${appt.firstName} ${appt.lastName}`,
      movedTo: statusName,
      opportunityId: opportunity.id,
    });

  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const { pipelineId, stages } = await getPipelineStages();
    res.json({
      status: '✅ Acuity → GHL Sync is running',
      pipeline: pipelineId,
      stages: Object.keys(stages),
      colorMappings: COLOR_TO_STATUS,
    });
  } catch (err) {
    res.status(500).json({ status: '❌ Error', error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Acuity → GHL Sync server running on ${HOST}:${PORT}`);
  console.log(`   Webhook URL: ${SERVER_URL}/webhook/acuity`);
  console.log(`   Health check: ${SERVER_URL}/\n`);
});
