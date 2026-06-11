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

// ── PIPELINE CONFIGS ───────────────────────────────────────────────────────
// Each entry: { tag, pipelineName, appointmentTypeId }
const PIPELINE_CONFIGS = [
    { tag: 'facebook - start a tv channel', pipelineName: 'META Leads', appointmentTypeId: parseInt(process.env.META_LEADS_APPOINTMENT_TYPE_ID) },
    { tag: 'facebook - podcasters', pipelineName: 'Podcasters', appointmentTypeId: parseInt(process.env.PODCASTERS_APPOINTMENT_TYPE_ID) },
];

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

// ── PIPELINE CACHE (keyed by pipeline name) ────────────────────────────────
const pipelineCache = {};

async function getPipelineStages(pipelineName) {
    if (pipelineCache[pipelineName]) return pipelineCache[pipelineName];
    const res = await ghl.get(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    const pipelines = res.data.pipelines || [];
    const pipeline = pipelines.find(p => p.name.toLowerCase() === pipelineName.toLowerCase());
    if (!pipeline) throw new Error(`Pipeline "${pipelineName}" not found in GHL`);
    console.log(`📋 Using pipeline: ${pipeline.name}`);
    const stages = {};
    for (const stage of pipeline.stages) {
        stages[stage.name] = stage.id;
        console.log(`   Stage: "${stage.name}" → ${stage.id}`);
    }
    pipelineCache[pipelineName] = { pipelineId: pipeline.id, stages };
    return pipelineCache[pipelineName];
}

// ── FIND GHL CONTACT BY EMAIL ──────────────────────────────────────────────
async function findContactByEmail(email) {
    const res = await ghl.get(`/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`);
    const contacts = res.data.contacts || [];
    return contacts[0] || null;
}

// ── MATCH CONTACT TO A PIPELINE CONFIG ────────────────────────────────────
function matchPipelineConfig(contact) {
    const tags = (contact.tags || []).map(t => t.toLowerCase());
    return PIPELINE_CONFIGS.find(cfg => tags.includes(cfg.tag.toLowerCase())) || null;
}

// ── FIND OPPORTUNITY IN A PIPELINE ────────────────────────────────────────
async function findOpportunity(contactId, pipelineId) {
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
    const userData = { em: [hashData(contact.email)] };
    if (contact.phone) userData.ph = [hashData(contact.phone.replace(/\D/g, ''))];
    if (contact.firstName) userData.fn = [hashData(contact.firstName)];
    if (contact.lastName) userData.ln = [hashData(contact.lastName)];

    const payload = {
        data: [{
            event_name: eventName,
            event_time: eventTime || Math.floor(Date.now() / 1000),
            action_source: 'system_generated',
            user_data: userData,
        }],
    };

    const url = `https://graph.facebook.com/v18.0/${datasetId}/events?access_token=${accessToken}`;
    const res = await axios.post(url, payload);
    console.log(`   ✅ Meta CAPI fired: ${eventName} → events_received: ${res.data.events_received}`);
    return res.data;
}

// ── HANDLE LIVE DEMO BOOKING ───────────────────────────────────────────────
async function handleLiveDemoBooking(appt) {
    console.log(`\n🎯 Live Demo booking detected for: ${appt.email}`);

    const contact = await findContactByEmail(appt.email);
    if (!contact) {
        console.log(`   ⚠️  Contact not found in GHL — skipping`);
        return { status: 'skipped', reason: 'contact not found in GHL' };
    }

    const config = matchPipelineConfig(contact);
    if (!config) {
        console.log(`   ⚠️  No matching pipeline tag found on contact — skipping`);
        return { status: 'skipped', reason: 'no matching pipeline tag' };
    }

    console.log(`   ✅ Matched: tag="${config.tag}" → pipeline="${config.pipelineName}"`);

    const { pipelineId, stages } = await getPipelineStages(config.pipelineName);
    const stageId = stages['Scheduled Demo'];
    if (!stageId) throw new Error(`Stage "Scheduled Demo" not found in "${config.pipelineName}" pipeline`);

    let opportunity = await findOpportunity(contact.id, pipelineId);
    if (opportunity) {
        await moveOpportunityToStage(opportunity.id, pipelineId, stageId);
        console.log(`   🚀 Moved to "Scheduled Demo"`);
    } else {
        opportunity = await createOpportunity(contact, pipelineId, stageId, `${contact.firstName} ${contact.lastName} - Live Demo`);
        console.log(`   ✨ Created opportunity in "Scheduled Demo"`);
    }

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

    return { status: 'success', action: 'scheduled_demo', pipeline: config.pipelineName, contact: `${appt.firstName} ${appt.lastName}` };
}

// ── HANDLE LABEL CHANGE ────────────────────────────────────────────────────
async function handleLabelChange(appt) {
    const color = (appt.labels?.[0]?.color || appt.labelColor)?.toLowerCase();
    console.log(`\n🏷️  Label change: color=${color || 'none'} for ${appt.email}`);

    if (!PIPELINE_CONFIGS.some(cfg => cfg.appointmentTypeId === appt.appointmentTypeID)) return null;

    const contact = await findContactByEmail(appt.email);
    if (!contact) {
        console.log(`   ⚠️  Contact not found — skipping`);
        return { status: 'skipped', reason: 'contact not found' };
    }

    const config = matchPipelineConfig(contact);
    if (!config) {
        console.log(`   ⚠️  No matching pipeline tag found on contact — skipping`);
        return { status: 'skipped', reason: 'no matching pipeline tag' };
    }

    const { pipelineId, stages } = await getPipelineStages(config.pipelineName);

    let targetStage;
    if (color === 'red') {
        targetStage = 'Missed Demo';
    } else if (color) {
        targetStage = 'Attended Demo';
    } else {
        return { status: 'skipped', reason: 'no label color' };
    }

    const stageId = stages[targetStage];
    if (!stageId) throw new Error(`Stage "${targetStage}" not found in "${config.pipelineName}"`);

    let opportunity = await findOpportunity(contact.id, pipelineId);
    if (opportunity) {
        await moveOpportunityToStage(opportunity.id, pipelineId, stageId);
        console.log(`   🚀 Moved to "${targetStage}"`);
    } else {
        opportunity = await createOpportunity(contact, pipelineId, stageId, `${contact.firstName} ${contact.lastName} - Live Demo`);
        console.log(`   ✨ Created opportunity in "${targetStage}"`);
    }

    return { status: 'success', action: targetStage, pipeline: config.pipelineName, contact: `${appt.firstName} ${appt.lastName}` };
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

        const apptRes = await acuity.get(`/appointments/${id}`);
        const appt = apptRes.data;
        console.log(`📅 Appointment: ${appt.firstName} ${appt.lastName} <${appt.email}>`);
        console.log(`   appointmentTypeID: ${appt.appointmentTypeID}`);
        console.log(`   Labels:`, JSON.stringify(appt.labels));

        const isLiveDemo = PIPELINE_CONFIGS.some(cfg => cfg.appointmentTypeId === appt.appointmentTypeID);

        if (isLiveDemo) {
            const color = (appt.labels?.[0]?.color || appt.labelColor)?.toLowerCase();

            if (normalizedAction === 'scheduled' || (normalizedAction === 'changed' && !color)) {
                const result = await handleLiveDemoBooking(appt);
                return res.json(result);
            }

            if (normalizedAction === 'changed' && color) {
                const result = await handleLabelChange(appt);
                if (result) return res.json(result);
            }

            return res.json({ status: 'ignored', reason: `Live Demo ${normalizedAction} - no action needed` });
        }

        return res.json({ status: 'ignored', reason: 'not a Live Demo appointment' });

    } catch (err) {
        console.error('❌ Error:', err.response?.data || err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
    try {
        const pipelines = await Promise.all(
            PIPELINE_CONFIGS.map(async cfg => {
                const { pipelineId, stages } = await getPipelineStages(cfg.pipelineName);
                return { tag: cfg.tag, pipeline: cfg.pipelineName, pipelineId, stages: Object.keys(stages) };
            })
        );
        res.json({
            status: '✅ Acuity → GHL Sync is running',
            pipelines,
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
