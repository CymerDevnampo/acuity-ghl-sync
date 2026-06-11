require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CONFIG ─────────────────────────────────────────────────────────────────
const ACUITY_USER_ID = process.env.ACUITY_USER_ID || '';
const ACUITY_API_KEY = process.env.ACUITY_API_KEY || '';
const GHL_API_TOKEN = process.env.GHL_API_TOKEN || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const SERVER_URL = process.env.SERVER_URL || 'http://YOUR_SERVER';

// ── META CAPI CONFIG ───────────────────────────────────────────────────────
const TVSTARTUP_DATASET_ID = process.env.TVSTARTUP_DATASET_ID || '';
const TVSTARTUP_ACCESS_TOKEN = process.env.TVSTARTUP_ACCESS_TOKEN || '';

// ── APPOINTMENT TYPE IDs ───────────────────────────────────────────────────
const LIVE_DEMO_APPOINTMENT_TYPE_ID = parseInt(process.env.LIVE_DEMO_APPOINTMENT_TYPE_ID || '78464550');

// ── META LEAD TAG ──────────────────────────────────────────────────────────
const META_LEAD_TAG = 'facebook - start a tv channel';

// ── COLOR → STAGE MAPPING (existing Acuity sync) ──────────────────────────
const COLOR_TO_STATUS = {
    'orange': 'Follow-up',
    'blue': 'Invoice Sent',
    'yellow': 'Rescheduled',
    'red': 'No Show',
    'green': 'Completed',
    'cyan': 'Completed',
    'gray': 'In Progress',
    'grey': 'In Progress',
    'violet': 'Closed',
};

// ── GHL API ────────────────────────────────────────────────────────────────
const ghl = axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: {
        'Authorization': `Bearer ${GHL_API_TOKEN}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
    },
});

// ── ACUITY API ─────────────────────────────────────────────────────────────
const acuity = axios.create({
    baseURL: 'https://acuityscheduling.com/api/v1',
    auth: { username: ACUITY_USER_ID, password: ACUITY_API_KEY },
});

// ── CACHE: pipelines ───────────────────────────────────────────────────────
let pipelineCache = null;         // existing Acuity sync pipeline
let metaLeadsPipelineCache = null; // Meta Leads pipeline

async function getPipelineStages() {
    if (pipelineCache) return pipelineCache;
    const res = await ghl.get(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    const pipelines = res.data.pipelines || [];
    if (!pipelines.length) throw new Error('No pipelines found in GHL');
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

async function getMetaLeadsPipelineStages() {
    if (metaLeadsPipelineCache) return metaLeadsPipelineCache;
    const res = await ghl.get(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    const pipelines = res.data.pipelines || [];
    const pipeline = pipelines.find(p => p.name === 'Meta Leads');
    if (!pipeline) throw new Error('Meta Leads pipeline not found in GHL');
    console.log('📋 Using META Leads pipeline:', pipeline.name);
    const stages = {};
    for (const stage of pipeline.stages) {
        stages[stage.name] = stage.id;
        console.log(`   Stage: "${stage.name}" → ${stage.id}`);
    }
    metaLeadsPipelineCache = { pipelineId: pipeline.id, stages };
    return metaLeadsPipelineCache;
}

// ── FIND GHL CONTACT BY EMAIL ──────────────────────────────────────────────
async function findContactByEmail(email) {
    const res = await ghl.get(`/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`);
    const contacts = res.data.contacts || [];
    return contacts[0] || null;
}

// ── CHECK IF CONTACT HAS META LEAD TAG ────────────────────────────────────
function contactHasMetaTag(contact) {
    const tags = contact.tags || [];
    return tags.some(tag => tag.toLowerCase() === META_LEAD_TAG.toLowerCase());
}

// ── FIND OPPORTUNITY IN META LEADS PIPELINE ───────────────────────────────
async function findMetaLeadsOpportunity(contactId, pipelineId) {
    const res = await ghl.get(`/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}`);
    const opps = res.data.opportunities || [];
    return opps.find(o => o.pipelineId === pipelineId) || null;
}

// ── FIND OPPORTUNITY (generic) ─────────────────────────────────────────────
async function findOpportunityByContact(contactId, pipelineId) {
    const res = await ghl.get(`/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}`);
    const opps = res.data.opportunities || [];
    return opps.find(o => o.pipelineId === pipelineId) || null;
}

// ── MOVE OPPORTUNITY TO STAGE ──────────────────────────────────────────────
async function moveOpportunityToStage(opportunityId, pipelineId, stageId) {
    const payload = { pipelineId, pipelineStageId: stageId, status: 'open' };
    console.log(`   📤 Moving opportunity ${opportunityId} to stage`);
    await ghl.put(`/opportunities/${opportunityId}`, payload);
}

// ── CREATE OPPORTUNITY ─────────────────────────────────────────────────────
async function createOpportunity(contact, pipelineId, stageId, name) {
    const payload = {
        pipelineId,
        locationId: GHL_LOCATION_ID,
        name: name || `${contact.firstName} ${contact.lastName}`,
        pipelineStageId: stageId,
        status: 'open',
        contactId: contact.id,
    };
    console.log('   📤 Creating opportunity:', payload.name);
    const res = await ghl.post('/opportunities/', payload);
    return res.data.opportunity;
}

// ── HASH FOR META CAPI ─────────────────────────────────────────────────────
function hashData(value) {
    if (!value) return undefined;
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

// ── FIRE META CAPI EVENT ───────────────────────────────────────────────────
async function fireMetaCAPI({ datasetId, accessToken, eventName, contact, eventTime }) {
    const userData = {
        em: [hashData(contact.email)],
    };
    if (contact.phone) userData.ph = [hashData(contact.phone.replace(/\D/g, ''))];
    if (contact.firstName) userData.fn = [hashData(contact.firstName)];
    if (contact.lastName) userData.ln = [hashData(contact.lastName)];

    const payload = {
        data: [
            {
                event_name: eventName,
                event_time: eventTime || Math.floor(Date.now() / 1000),
                action_source: 'system_generated',
                user_data: userData,
            },
        ],
    };

    const url = `https://graph.facebook.com/v18.0/${datasetId}/events?access_token=${accessToken}`;
    const res = await axios.post(url, payload);
    console.log(`   ✅ Meta CAPI fired: ${eventName} → events_received: ${res.data.events_received}`);
    return res.data;
}

// ── HANDLE LIVE DEMO BOOKING (Task 2) ─────────────────────────────────────
async function handleLiveDemoBooking(appt) {
    console.log(`\n🎯 Live Demo booking detected for: ${appt.email}`);

    // Find contact in GHL
    const contact = await findContactByEmail(appt.email);
    if (!contact) {
        console.log(`   ⚠️  Contact not found in GHL for: ${appt.email} — skipping`);
        return { status: 'skipped', reason: 'contact not found in GHL' };
    }

    // Check if contact has Meta lead tag
    if (!contactHasMetaTag(contact)) {
        console.log(`   ⚠️  Contact does not have tag "${META_LEAD_TAG}" — skipping Meta CAPI`);
        return { status: 'skipped', reason: 'contact not a meta lead' };
    }

    console.log(`   ✅ Meta lead matched: ${contact.firstName} ${contact.lastName}`);

    // Get META Leads pipeline
    const { pipelineId, stages } = await getMetaLeadsPipelineStages();
    const stageId = stages['Scheduled Demo'];
    if (!stageId) throw new Error('Stage "Scheduled Demo" not found in Meta Leads pipeline');

    // Find or create opportunity
    let opportunity = await findMetaLeadsOpportunity(contact.id, pipelineId);
    if (opportunity) {
        await moveOpportunityToStage(opportunity.id, pipelineId, stageId);
        console.log(`   🚀 Moved to "Scheduled Demo"`);
    } else {
        opportunity = await createOpportunity(contact, pipelineId, stageId, `${contact.firstName} ${contact.lastName} - Live Demo`);
        console.log(`   ✨ Created opportunity in "Scheduled Demo"`);
    }

    // Fire Meta CAPI Schedule event
    await fireMetaCAPI({
        datasetId: TVSTARTUP_DATASET_ID,
        accessToken: TVSTARTUP_ACCESS_TOKEN,
        eventName: 'Schedule',
        contact: {
            email: appt.email,
            phone: appt.phone,
            firstName: appt.firstName,
            lastName: appt.lastName,
        },
    });

    return { status: 'success', action: 'scheduled_demo', contact: `${appt.firstName} ${appt.lastName}` };
}

// ── HANDLE LABEL CHANGE (Task 3) ───────────────────────────────────────────
async function handleLabelChange(appt) {
    const color = (appt.labels?.[0]?.color || appt.labelColor)?.toLowerCase();
    console.log(`\n🏷️  Label change detected: color=${color || 'none'} for ${appt.email}`);

    // Only process if it's a Live Demo appointment
    if (appt.appointmentTypeID !== LIVE_DEMO_APPOINTMENT_TYPE_ID) {
        // Fall through to existing color→status mapping for other appointments
        return null;
    }

    const contact = await findContactByEmail(appt.email);
    if (!contact) {
        console.log(`   ⚠️  Contact not found — skipping`);
        return { status: 'skipped', reason: 'contact not found' };
    }

    if (!contactHasMetaTag(contact)) {
        console.log(`   ⚠️  Not a meta lead — skipping`);
        return { status: 'skipped', reason: 'not a meta lead' };
    }

    const { pipelineId, stages } = await getMetaLeadsPipelineStages();

    let targetStage;
    if (color === 'red') {
        targetStage = 'Missed Demo';
    } else if (color) {
        targetStage = 'Attended Demo';
    } else {
        return { status: 'skipped', reason: 'no label color' };
    }

    const stageId = stages[targetStage];
    if (!stageId) throw new Error(`Stage "${targetStage}" not found`);

    let opportunity = await findMetaLeadsOpportunity(contact.id, pipelineId);
    if (opportunity) {
        await moveOpportunityToStage(opportunity.id, pipelineId, stageId);
        console.log(`   🚀 Moved to "${targetStage}"`);
    } else {
        opportunity = await createOpportunity(contact, pipelineId, stageId, `${contact.firstName} ${contact.lastName} - Live Demo`);
        console.log(`   ✨ Created opportunity in "${targetStage}"`);
    }

    return { status: 'success', action: targetStage, contact: `${appt.firstName} ${appt.lastName}` };
}

// ── MAIN WEBHOOK HANDLER ───────────────────────────────────────────────────
app.post('/webhook/acuity', async (req, res) => {
    try {
        const { action, id } = req.body;
        console.log(`\n🔔 Acuity webhook: action=${action}, id=${id}`);

        const normalizedAction = action.replace('appointment.', '');
        if (!['scheduled', 'rescheduled', 'changed', 'canceled'].includes(normalizedAction)) {
            return res.json({ status: 'ignored', reason: 'unhandled action' });
        }

        // Fetch full appointment from Acuity
        const apptRes = await acuity.get(`/appointments/${id}`);
        const appt = apptRes.data;
        console.log(`📅 Appointment: ${appt.firstName} ${appt.lastName} <${appt.email}>`);
        console.log(`   appointmentTypeID: ${appt.appointmentTypeID}`);
        console.log(`   Labels:`, JSON.stringify(appt.labels));

        // ── TASK 2: Live Demo Booking (scheduled or changed with no label = new booking) ──
        if (appt.appointmentTypeID === LIVE_DEMO_APPOINTMENT_TYPE_ID) {
            const color = (appt.labels?.[0]?.color || appt.labelColor)?.toLowerCase();

            // If scheduled OR changed with no label = treat as new booking
            if (normalizedAction === 'scheduled' || (normalizedAction === 'changed' && !color)) {
                const result = await handleLiveDemoBooking(appt);
                return res.json(result);
            }

            // If changed with a label = treat as attendance update
            if (normalizedAction === 'changed' && color) {
                const result = await handleLabelChange(appt);
                if (result) return res.json(result);
            }

            // For rescheduled or canceled, just ignore for now
            return res.json({ status: 'ignored', reason: `Live Demo ${normalizedAction} - no action needed` });
        }

        // ── EXISTING: Color → Stage mapping for other appointments ────────────
        const color = (appt.labels?.[0]?.color || appt.labelColor)?.toLowerCase();
        const statusName = COLOR_TO_STATUS[color];

        if (!statusName) {
            console.log(`   ⚠️  No mapping for color "${color}" — skipping`);
            return res.json({ status: 'ignored', reason: `no mapping for color: ${color}` });
        }

        const { pipelineId, stages } = await getPipelineStages();
        const stageId = stages[statusName];
        if (!stageId) {
            return res.status(400).json({ error: `Stage "${statusName}" not found` });
        }

        const contact = await findContactByEmail(appt.email);
        if (!contact) {
            return res.status(404).json({ error: `Contact not found: ${appt.email}` });
        }

        let opportunity = await findOpportunityByContact(contact.id, pipelineId);
        if (opportunity) {
            await moveOpportunityToStage(opportunity.id, pipelineId, stageId);
            console.log(`   🚀 Moved to "${statusName}"`);
        } else {
            opportunity = await createOpportunity(contact, pipelineId, stageId, null);
            console.log(`   ✨ Created opportunity in "${statusName}"`);
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
            liveDemoAppointmentTypeId: LIVE_DEMO_APPOINTMENT_TYPE_ID,
            metaLeadTag: META_LEAD_TAG,
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