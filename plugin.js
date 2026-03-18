import { createRawPrompt, eventSource, event_types, extension_prompt_roles, extension_prompt_types, generateRaw, getCurrentChatId, getRequestHeaders, is_send_press, saveSettingsDebounced, substituteParamsExtended } from '../../../../script.js';
import { ModuleWorkerWrapper, extension_settings, getContext } from '../../../extensions.js';
import { is_group_generating } from '../../../group-chats.js';
import { getBase64Async, waitUntilCondition } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { getMultimodalCaption } from '../../shared.js';
import { localforage, DOMPurify } from '../../../../lib.js';

const gameStore = localforage.createInstance({ name: 'SillyTavern_MazeGame' });
const baseUrl = new URL('plugin.html', import.meta.url).toString();
const docUrl = 'https://emulatorjs.org/docs4devs/cores';
const canvas = new OffscreenCanvas(512, 512);
const MOVEMENT_LOGS_STORAGE_KEY = 'movement_logs_v1';
const MOVEMENT_LOGS_SCHEMA_VERSION = 1;
const MOVEMENT_LOGS_MAX_SESSIONS = 500;

let currentGame = '';
let currentCore = '';
let currentGameSeed = null;
let commentTimer = null;
let movementTimer = null;
let gamesLaunched = 0;
let movementTickCounter = 0;
let movementLastAction = '-';
let movementSessionMemory = null;
let commentaryGenerateInFlight = false;
let commentaryGeneratePending = false;
let audioTelemetrySaveTimer = null;
let movementMemoryLogSaveTimer = null;

const COMMENTARY_PROMPT_KEY = 'mazegame_live_commentary';

const defaultSettings = {
    runtimeMode: 'coop',
    legacyCommentIntervalSeconds: 0,
    commentInterval: 0,
    captionPrompt: 'This is a screenshot of "{{game}}" game played on {{core}}. Provide a detailed description of what is happening in the game.',
    commentPrompt: '{{user}} is playing "{{game}}" on {{core}}. Write a {{random:cheeky, snarky, funny, clever, witty, teasing, quirky, sly, saucy}} comment from {{char}}\'s perspective based on the following:\n\n{{caption}}',
    forceCaptions: false,
    movementEnabled: true,
    movementPlayer: 0,
    movementIntervalSeconds: 20,
    movementHoldMs: 200,
    movementStepDelayMs: 150,
    movementMaxActionsPerTick: 4,
    movementStartupDelaySeconds: 20,
    movementCommentEnabled: true,
    movementCommentEveryTicks: 4,
    movementUseCommentPrompt: true,
    movementUseCaptionPrompt: true,
    movementSamplerTemperature: 0.2,
    movementSamplerTopP: 1,
    movementSamplerTopK: 1,
    movementSamplerMinP: 0,
    movementSamplerTypical: 1,
    movementSamplerTfs: 1,
    movementSamplerMirostat: 0,
    movementSamplerMirostatTau: 5,
    movementSamplerMirostatEta: 0.1,
    movementSamplerRepPen: 1,
    movementSamplerRepetitionPenalty: 1,
    movementFallbackMode: 'clockwise',
    movementLoopBreakEnabled: true,
    movementStopWhenPaused: true,
    movementSystemPrompt: 'You are a game controller. Output only allowed action tokens and nothing else.',
    movementFinalInstruction: 'Return 1 to {{max}} comma-separated actions from the allowed set only: {{allowed}}.',
    movementShowLastDirection: false,
    movementShowTickCounter: false,
    movementLogDecisions: false,
    movementAllowedActions: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER'],
    profileMigrationVersion: 0,
    globalDefaultControlSettings: null,
    globalDefaultCoreSettings: null,
    globalDefaultCheats: null,
    shaderScanlineStrength: 0.225,
    shaderDitherStrength: 0.8,
    shaderColorSteps: 32.0,
    shaderVignette: 0.7,
};

const MANSION_MIGRATION_VERSION = 1;

const commentWorker = new ModuleWorkerWrapper(provideComment);

const ACTION_INDEX = {
    UP: 4,
    DOWN: 5,
    LEFT: 6,
    RIGHT: 7,
    ENTER: 8,
    A: 8,
    B: 0,
    C: 1,
    X: 9,
    Y: 1,
    Z: 0,
    L1: 10,
    R1: 11,
    L2: 12,
    R2: 13,
};

const AI_ACTION_ORDER = ['UP', 'RIGHT', 'DOWN', 'LEFT', 'ENTER', 'A', 'B', 'C', 'X', 'Y', 'Z', 'L1', 'R1', 'L2', 'R2'];

const MOVEMENT_TICK_MS = 20000;
const MOVEMENT_HOLD_MS = 200;
const COMMENT_EVERY_TICKS = 4;
const MOVEMENT_CONTEXT_CHAR_BUDGET = 10000;
const AUDIO_TELEMETRY_MAX_EVENTS = 1200;
const MOVEMENT_LOOP_BREAK_THRESHOLD = 5;
const DPAD_ACTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
const MOVEMENT_ALLOWED_ACTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER'];
let mazeObjectiveState = {
    text: 'Find the brass key and unlock the study door.',
    status: 'active',
    hint: 'Explore and press ENTER near interactable objects.',
    interactAvailable: false,
    layout: null,
};

function formatObjectiveLayout(layout) {
    if (!layout || typeof layout !== 'object') return 'unknown';
    const strategy = String(layout.strategy || 'unknown');
    const alcoveCount = Number.isFinite(Number(layout.alcoveCount)) ? Number(layout.alcoveCount) : 'n/a';
    const fmt = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : '?');
    const key = layout.key && typeof layout.key === 'object'
        ? `key=(${fmt(layout.key.x)},${fmt(layout.key.y)})@${fmt(layout.key.faceDir)}`
        : 'key=(?)';
    const door = layout.door && typeof layout.door === 'object'
        ? `door=(${fmt(layout.door.x)},${fmt(layout.door.y)})@${fmt(layout.door.faceDir)}`
        : 'door=(?)';
    return `strategy=${strategy} alcoves=${alcoveCount} ${key} ${door}`;
}

function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function getMovementConfig() {
    const s = extension_settings.mazegame || {};
    let allowed = Array.isArray(s.movementAllowedActions) ? s.movementAllowedActions : ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER'];
    allowed = allowed.map(x => String(x || '').toUpperCase()).filter(x => MOVEMENT_ALLOWED_ACTIONS.includes(x));
    allowed = [...new Set(allowed)];
    if (!allowed.length) {
        allowed = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER'];
    }
    const sampler = {
        temperature: clampNumber(s.movementSamplerTemperature, 0.2, 0, 2),
        topP: clampNumber(s.movementSamplerTopP, 1, 0, 1),
        topK: clampNumber(s.movementSamplerTopK, 1, 0, 200),
        minP: clampNumber(s.movementSamplerMinP, 0, 0, 1),
        typical: clampNumber(s.movementSamplerTypical, 1, 0, 1),
        tfs: clampNumber(s.movementSamplerTfs, 1, 0, 1),
        mirostat: clampNumber(s.movementSamplerMirostat, 0, 0, 2),
        mirostatTau: clampNumber(s.movementSamplerMirostatTau, 5, 0, 20),
        mirostatEta: clampNumber(s.movementSamplerMirostatEta, 0.1, 0, 2),
        repPen: clampNumber(s.movementSamplerRepPen, 1, 1, 2),
        repetitionPenalty: clampNumber(s.movementSamplerRepetitionPenalty, 1, 1, 2),
    };
    return {
        enabled: !!s.movementEnabled,
        player: clampNumber(s.movementPlayer, 0, 0, 1),
        intervalMs: clampNumber(s.movementIntervalSeconds, MOVEMENT_TICK_MS / 1000, 0, 3600) * 1000,
        holdMs: clampNumber(s.movementHoldMs, MOVEMENT_HOLD_MS, 50, 1000),
        stepDelayMs: clampNumber(s.movementStepDelayMs, 150, 0, 2000),
        maxActionsPerTick: clampNumber(s.movementMaxActionsPerTick, 4, 1, 12),
        startupDelayMs: clampNumber(s.movementStartupDelaySeconds, MOVEMENT_TICK_MS / 1000, 0, 120) * 1000,
        commentEnabled: !!s.movementCommentEnabled,
        commentEveryTicks: clampNumber(s.movementCommentEveryTicks, COMMENT_EVERY_TICKS, 1, 20),
        apiServerUrl: String(s.movementApiServerUrl || '').trim(),
        sampler: {
            temperature: clampNumber(s.movementSamplerTemperature ?? 0.2, 0.2, 0, 2),
            topP: clampNumber(s.movementSamplerTopP ?? 1, 1, 0, 1),
            topK: clampNumber(s.movementSamplerTopK ?? 1, 1, 0, 200),
            minP: clampNumber(s.movementSamplerMinP ?? 0, 0, 0, 1),
            typical: clampNumber(s.movementSamplerTypical ?? 1, 1, 0, 1),
            tfs: clampNumber(s.movementSamplerTfs ?? 1, 1, 0, 1),
            mirostat: clampNumber(s.movementSamplerMirostat ?? 0, 0, 0, 2),
            mirostatTau: clampNumber(s.movementSamplerMirostatTau ?? 5, 5, 0, 20),
            mirostatEta: clampNumber(s.movementSamplerMirostatEta ?? 0.1, 0.1, 0, 2),
            repPen: clampNumber(s.movementSamplerRepPen ?? 1, 1, 1, 2),
            repetitionPenalty: clampNumber(s.movementSamplerRepetitionPenalty ?? 1, 1, 1, 2),
        },
        fallbackMode: ['clockwise', 'random'].includes(s.movementFallbackMode) ? s.movementFallbackMode : 'clockwise',
        loopBreakEnabled: s.movementLoopBreakEnabled !== false,
        stopWhenPaused: s.movementStopWhenPaused !== false,
        systemPrompt: String(s.movementSystemPrompt || defaultSettings.movementSystemPrompt),
        finalInstruction: String(s.movementFinalInstruction || defaultSettings.movementFinalInstruction),
        showLastDirection: !!s.movementShowLastDirection,
        showTickCounter: !!s.movementShowTickCounter,
        logDecisions: !!s.movementLogDecisions,
        allowedActions: allowed,
        sampler,
    };
}

async function generateMovementDecisionText(prompt, cfg) {
    if (cfg.apiServerUrl) {
        const parityPrompt = createRawPrompt(prompt, 'textgenerationwebui', false, false, cfg.systemPrompt, '');
        const response = await fetch('/api/backends/text-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                api_type: 'koboldcpp',
                api_server: cfg.apiServerUrl,
                stream: false,
                prompt: parityPrompt,
                max_tokens: 48,
                temperature: cfg.sampler.temperature,
                top_p: cfg.sampler.topP,
                top_k: cfg.sampler.topK,
                min_p: cfg.sampler.minP,
                typical: cfg.sampler.typical,
                tfs: cfg.sampler.tfs,
                mirostat: cfg.sampler.mirostat,
                mirostat_tau: cfg.sampler.mirostatTau,
                mirostat_eta: cfg.sampler.mirostatEta,
                rep_pen: cfg.sampler.repPen,
                repetition_penalty: cfg.sampler.repetitionPenalty,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Movement backend request failed: ${response.status} ${text}`);
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.text;
        return String(text || '').trim();
    }

    return await generateRaw({
        prompt,
        systemPrompt: cfg.systemPrompt,
        responseLength: 48,
        trimNames: true,
    });
}

function getRuntimeMode() {
    const mode = String(extension_settings.mazegame?.runtimeMode || 'coop').toLowerCase();
    return mode === 'legacy' ? 'legacy' : 'coop';
}

function getLegacyCommentIntervalSeconds() {
    const s = extension_settings.mazegame || {};
    const legacy = Number(s.legacyCommentIntervalSeconds);
    if (Number.isFinite(legacy)) {
        return Math.max(0, legacy);
    }
    const oldValue = Number(s.commentInterval);
    return Number.isFinite(oldValue) ? Math.max(0, oldValue) : 0;
}

function updateRuntimeModeUI() {
    const mode = getRuntimeMode();
    const coopSection = $('#mazegame_coop_section');
    const legacySection = $('#mazegame_legacy_section');
    const active = $('#mazegame_runtime_active');
    const isCoop = mode === 'coop';

    coopSection.toggle(isCoop);
    legacySection.toggle(!isCoop);
    active.text(isCoop ? 'Active: Co-op Movement' : 'Active: Legacy Commentary');
}

function ensureAudioTelemetryState() {
    const s = extension_settings.mazegame;
    if (!s.audioTelemetry || typeof s.audioTelemetry !== 'object') {
        s.audioTelemetry = {
            events: [],
            summary: {
                interruptions: 0,
                discontinuities: 0,
                maxDriftMs: 0,
                resumeAttempts: 0,
                resumeFailures: 0,
                lastState: 'unknown',
                updatedAt: 0,
            },
            session: null,
        };
    }
    if (!Array.isArray(s.audioTelemetry.events)) {
        s.audioTelemetry.events = [];
    }
    if (!s.audioTelemetry.summary || typeof s.audioTelemetry.summary !== 'object') {
        s.audioTelemetry.summary = {
            interruptions: 0,
            discontinuities: 0,
            maxDriftMs: 0,
            resumeAttempts: 0,
            resumeFailures: 0,
            lastState: 'unknown',
            updatedAt: 0,
        };
    }
    return s.audioTelemetry;
}

function scheduleAudioTelemetrySave() {
    if (audioTelemetrySaveTimer) return;
    audioTelemetrySaveTimer = setTimeout(() => {
        audioTelemetrySaveTimer = null;
        saveSettingsDebounced();
    }, 1000);
}

function recordAudioTelemetryEvent(event) {
    if (!event || typeof event !== 'object') return;

    const telemetry = ensureAudioTelemetryState();
    const entry = {
        ts: Number(event.ts) || Date.now(),
        ...event,
    };

    telemetry.events.push(entry);
    if (telemetry.events.length > AUDIO_TELEMETRY_MAX_EVENTS) {
        telemetry.events.splice(0, telemetry.events.length - AUDIO_TELEMETRY_MAX_EVENTS);
    }

    const summary = telemetry.summary;
    const type = String(entry.type || '');

    if (type === 'session_start') {
        telemetry.session = {
            ts: entry.ts,
            core: entry.core || 'unknown',
            game: entry.game || 'unknown',
            config: entry.config || {},
            ua: entry.ua || navigator.userAgent,
        };
    }

    if (type === 'audio_ctx_state') {
        summary.lastState = String(entry.state || 'unknown');
        if (summary.lastState === 'interrupted' || summary.lastState === 'suspended') {
            summary.interruptions = Number(summary.interruptions || 0) + 1;
        }
    }

    if (type === 'audio_ctx_resume_attempt') {
        summary.resumeAttempts = Number(summary.resumeAttempts || 0) + 1;
        if (entry.ok === false) {
            summary.resumeFailures = Number(summary.resumeFailures || 0) + 1;
        }
    }

    if (type === 'audio_clock_discontinuity') {
        const drift = Math.abs(Number(entry.driftMs) || 0);
        summary.discontinuities = Number(summary.discontinuities || 0) + 1;
        summary.maxDriftMs = Math.max(Number(summary.maxDriftMs || 0), drift);
    }

    summary.updatedAt = Date.now();
    scheduleAudioTelemetrySave();
}

function onWindowAudioTelemetryMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'EJS_AUDIO_TELEMETRY') return;
    if (!data.event || typeof data.event !== 'object') return;
    recordAudioTelemetryEvent(data.event);
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function isCoreProfileObject(value) {
    return !!value && typeof value === 'object'
        && !!value.controlSettings
        && !!value.settings
        && Array.isArray(value.cheats);
}

function getGlobalDefaultsTemplate() {
    const s = extension_settings.mazegame || {};
    if (!s.globalDefaultControlSettings || !s.globalDefaultCoreSettings) {
        return null;
    }
    return {
        controlSettings: cloneJson(s.globalDefaultControlSettings),
        settings: cloneJson(s.globalDefaultCoreSettings),
        cheats: Array.isArray(s.globalDefaultCheats) ? cloneJson(s.globalDefaultCheats) : [],
    };
}

function runOneTimeMansionProfileMigration() {
    const s = extension_settings.mazegame;
    if ((s.profileMigrationVersion || 0) >= MANSION_MIGRATION_VERSION) {
        return;
    }

    let mansionProfile = null;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('ejs-') || !key.endsWith('-settings')) continue;
        if (!key.toLowerCase().includes('mansion of hidden souls')) continue;

        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '{}');
            if (isCoreProfileObject(parsed)) {
                mansionProfile = parsed;
                break;
            }
        } catch {
            // Ignore malformed profile
        }
    }

    if (!mansionProfile) {
        s.profileMigrationVersion = MANSION_MIGRATION_VERSION;
        saveSettingsDebounced();
        return;
    }

    s.globalDefaultControlSettings = cloneJson(mansionProfile.controlSettings);
    s.globalDefaultCoreSettings = cloneJson(mansionProfile.settings);
    s.globalDefaultCheats = cloneJson(mansionProfile.cheats || []);

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('ejs-') || !key.endsWith('-settings')) continue;
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '{}');
            if (!isCoreProfileObject(parsed)) continue;
            parsed.controlSettings = cloneJson(mansionProfile.controlSettings);
            parsed.settings = cloneJson(mansionProfile.settings);
            parsed.cheats = cloneJson(mansionProfile.cheats || []);
            localStorage.setItem(key, JSON.stringify(parsed));
        } catch {
            // Ignore malformed profile
        }
    }

    s.profileMigrationVersion = MANSION_MIGRATION_VERSION;
    saveSettingsDebounced();
}

function updateMovementDebugUI() {
    const cfg = getMovementConfig();
    const lastDirWrap = $('#mazegame_last_direction_wrap');
    const tickWrap = $('#mazegame_tick_counter_wrap');
    const lastDirText = $('#mazegame_last_direction');
    const tickText = $('#mazegame_tick_counter');

    lastDirWrap.toggle(cfg.showLastDirection);
    tickWrap.toggle(cfg.showTickCounter);
    lastDirText.text(movementLastAction);
    tickText.text(String(movementTickCounter));
}

function setCommentaryPrompt(text) {
    const ctx = getContext();
    if (typeof ctx?.setExtensionPrompt !== 'function') {
        return;
    }
    ctx.setExtensionPrompt(
        COMMENTARY_PROMPT_KEY,
        String(text || ''),
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function clearCommentaryPrompt() {
    setCommentaryPrompt('');
}

async function triggerCommentaryGeneration() {
    const ctx = getContext();
    if (!ctx || typeof ctx.generate !== 'function') {
        return;
    }

    if (commentaryGenerateInFlight) {
        commentaryGeneratePending = true;
        return;
    }

    commentaryGenerateInFlight = true;
    try {
        const beforeCount = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
        await ctx.generate('normal', { automatic_trigger: true });

        const afterCount = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
        if (afterCount > 0) {
            const messageId = afterCount - 1;
            await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'emulatorjs-commentary');
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'emulatorjs-commentary');
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageId, 'emulatorjs-commentary');
            recordAudioTelemetryEvent({
                type: 'commentary_tts_signaled',
                messageId,
                appended: afterCount > beforeCount,
            });
        }
    } catch (error) {
        recordAudioTelemetryEvent({
            type: 'commentary_error',
            stage: 'generate',
            error: String(error?.message || error || 'unknown_error'),
        });
        console.warn('MazeGame commentary generation failed', error);
    } finally {
        commentaryGenerateInFlight = false;
        if (commentaryGeneratePending) {
            commentaryGeneratePending = false;
            await triggerCommentaryGeneration();
        }
    }
}

function beginMovementSession(reason = 'start') {
    movementSessionMemory = {
        sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: Date.now(),
        reason,
        seed: Number.isFinite(Number(currentGameSeed)) ? Number(currentGameSeed) : null,
        entries: [],
    };
    scheduleMovementMemoryLogWrite();
}

function endMovementSession() {
    const snapshot = movementSessionMemory ? cloneJson(movementSessionMemory) : null;
    movementSessionMemory = null;
    if (snapshot) {
        void writeMovementMemoryLog(snapshot);
    }
}

function addMovementMemoryEntry(tick, captionFull, action, meta = {}) {
    if (!movementSessionMemory) {
        beginMovementSession('auto');
    }
    movementSessionMemory.entries.push({
        tick,
        captionFull: String(captionFull || ''),
        action: Array.isArray(action) ? action.join(',') : String(action || ''),
        timestamp: Date.now(),
        loopBreak: !!meta.loopBreak,
        loopStreak: Number(meta.loopStreak) || 0,
        loopOriginalAction: String(meta.loopOriginalAction || ''),
    });
    scheduleMovementMemoryLogWrite();
}

function formatMovementMemoryLogText(session) {
    if (!session || typeof session !== 'object') {
        return 'No movement session memory available.\n';
    }

    const lines = [];
    lines.push('MazeGame Movement Memory Buffer');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Game: ${currentGame || 'unknown'}`);
    lines.push(`Core: ${currentCore || 'unknown'}`);
    lines.push(`Seed: ${Number.isFinite(Number(session.seed)) ? Number(session.seed) : 'unknown'}`);
    lines.push(`Session ID: ${String(session.sessionId || 'unknown')}`);
    lines.push(`Session Start: ${new Date(Number(session.startedAt) || Date.now()).toISOString()}`);
    lines.push(`Reason: ${String(session.reason || 'unknown')}`);
    lines.push(`Objective Layout: ${formatObjectiveLayout(mazeObjectiveState?.layout)}`);
    lines.push('');

    const entries = Array.isArray(session.entries) ? session.entries : [];
    if (!entries.length) {
        lines.push('No entries yet.');
        return lines.join('\n') + '\n';
    }

    for (const entry of entries) {
        const tick = Number(entry?.tick) || 0;
        const action = String(entry?.action || '').trim() || '-';
        const ts = new Date(Number(entry?.timestamp) || Date.now()).toISOString();
        const caption = String(entry?.captionFull || '').replace(/\s+/g, ' ').trim();
        const loopBreak = entry?.loopBreak ? ` loopBreak=true streak=${Number(entry?.loopStreak) || 0} from=${String(entry?.loopOriginalAction || '-')}` : '';
        lines.push(`[${ts}] tick=${tick} action=${action}${loopBreak}`);
        lines.push(`caption: ${caption || '(empty)'}`);
        lines.push('');
    }

    return lines.join('\n').trimEnd() + '\n';
}

function scheduleMovementMemoryLogWrite() {
    if (movementMemoryLogSaveTimer) return;
    movementMemoryLogSaveTimer = setTimeout(() => {
        movementMemoryLogSaveTimer = null;
        void writeMovementMemoryLog(movementSessionMemory);
    }, 1000);
}

async function getStoredMovementLogs() {
    const raw = await gameStore.getItem(MOVEMENT_LOGS_STORAGE_KEY);
    return Array.isArray(raw) ? raw : [];
}

async function setStoredMovementLogs(logs) {
    await gameStore.setItem(MOVEMENT_LOGS_STORAGE_KEY, logs);
}

async function appendMovementLogSession(session) {
    const logs = await getStoredMovementLogs();
    const sessionId = String(session?.sessionId || '');
    const withoutDupes = logs.filter(x => String(x?.sessionId || '') !== sessionId);
    withoutDupes.push(session);
    if (withoutDupes.length > MOVEMENT_LOGS_MAX_SESSIONS) {
        withoutDupes.splice(0, withoutDupes.length - MOVEMENT_LOGS_MAX_SESSIONS);
    }
    await setStoredMovementLogs(withoutDupes);
}

function buildMovementLogExportPayload(sessions) {
    return {
        schemaVersion: MOVEMENT_LOGS_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        game: currentGame || 'MazeGame',
        core: currentCore || 'unknown',
        sessions,
    };
}

function downloadJsonFile(filename, payload) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function exportMovementLogsJson() {
    try {
        const sessions = await getStoredMovementLogs();
        const payload = buildMovementLogExportPayload(sessions);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadJsonFile(`mazegame-movement-logs-${stamp}.json`, payload);
        toastr.success(`Exported ${sessions.length} movement sessions as JSON.`, 'MazeGame');
    } catch (error) {
        console.warn('Failed to export movement logs.', error);
        toastr.error('Failed to export movement logs.', 'MazeGame');
    }
}

async function writeMovementMemoryLog(session) {
    if (!session || typeof session !== 'object') return;
    try {
        const normalized = cloneJson(session);
        normalized.schemaVersion = MOVEMENT_LOGS_SCHEMA_VERSION;
        normalized.savedAt = Date.now();
        normalized.summaryText = formatMovementMemoryLogText(session);
        await appendMovementLogSession(normalized);
    } catch (error) {
        console.warn('Failed to persist movement memory log.', error);
    }
}

function renderMovementInstruction(template, allowedActions, maxActionsPerTick) {
    const base = String(template || defaultSettings.movementFinalInstruction);
    const withMacros = substituteParamsExtended(base, { game: currentGame, core: currentCore });
    return withMacros
        .replaceAll('{{max}}', String(maxActionsPerTick))
        .replaceAll('{{allowed}}', allowedActions.join(', '));
}

function prioritizeDirections(availableActions, lastAction, last4Actions, seed = 0) {
    if (!availableActions.length) return availableActions;

    const hasTurns = availableActions.includes('LEFT') || availableActions.includes('RIGHT');
    const hasUp = availableActions.includes('UP');
    const rand = seed ? (seed * 9301 % 100) / 100 : Math.random();

    if (last4Actions === 'LRLR' || last4Actions === 'RLRL') {
        if (availableActions.includes(lastAction)) {
            return [lastAction, ...availableActions.filter(d => d !== lastAction)];
        }
    }

    if (lastAction === 'UP' && hasTurns) {
        const turns = [];
        if (availableActions.includes('LEFT')) turns.push('LEFT');
        if (availableActions.includes('RIGHT')) turns.push('RIGHT');

        if (turns.length === 2 && rand < 0.5) {
            turns.reverse();
        }

        const result = [...turns];
        if (hasUp) result.push('UP');
        for (const dir of availableActions) {
            if (!result.includes(dir)) result.push(dir);
        }
        return result;
    }

    if (['LEFT', 'RIGHT'].includes(lastAction) && hasUp) {
        return ['UP', ...availableActions.filter(d => d !== 'UP')];
    }

    return availableActions;
}

function buildMovementPromptFromMemory(currentCaption, allowedActions, maxActionsPerTick, finalInstructionTemplate, shuffleSeed = 0) {
    const allowedText = allowedActions.join(', ');
    const header = substituteParamsExtended(
        'You are controlling movement in "{{game}}" on {{core}}.\n' +
        `Allowed actions: ${allowedText}.\n` +
        `Return 1 to ${maxActionsPerTick} actions as comma-separated tokens from the allowed set only.\n` +
        'Example: UP,RIGHT,ENTER\n' +
        'START and SELECT are reserved for the user.',
        { game: currentGame, core: currentCore },
    );

    const objectiveText = String(mazeObjectiveState?.text || 'Find the maze objective.');
    const objectiveStatus = String(mazeObjectiveState?.status || 'active');
    const objectiveHint = String(mazeObjectiveState?.hint || '');
    const interactAvailable = mazeObjectiveState?.interactAvailable ? 'yes' : 'no';
    const doorInteractable = mazeObjectiveState?.doorInteractable ? 'yes' : 'no';
    const entries = movementSessionMemory?.entries || [];
    let lastAction = null;
    let last4Actions = '';
    if (entries.length > 0) {
        lastAction = String(entries[entries.length - 1].action || '').split(',')[0].trim().toUpperCase();
        const recent = entries.slice(-4);
        last4Actions = recent.map(e => String(e.action || '').split(',')[0].trim().toUpperCase()).join('');
    }

    const availableActions = mazeObjectiveState?.availableActions || [];
    const prioritizedAvailable = prioritizeDirections(availableActions, lastAction, last4Actions, shuffleSeed);
    const availableDirsNote = prioritizedAvailable.length > 0 ? `\nNote: Available directions: ${prioritizedAvailable.join(', ')}.` : '';

    const objectiveBlock =
        `Current objective: ${objectiveText}\n` +
        `Objective status: ${objectiveStatus}\n` +
        `Interaction available now: ${interactAvailable}\n` +
        (doorInteractable === 'yes' ? 'Note: You have collected the key and the study door is now interactable.\n' : '') +
        (objectiveHint ? `Objective hint: ${objectiveHint}` : '');

    const currentBlock = `Current scene caption (full):\n${String(currentCaption || 'No caption available.')}`;

    const used = header.length + objectiveBlock.length + currentBlock.length + 240;
    const remaining = Math.max(0, MOVEMENT_CONTEXT_CHAR_BUDGET - used);

    const blocks = entries.map(e => `\nTick ${e.tick}: ACTION ${e.action}\nCAPTION (full):\n${e.captionFull}\n`);
    let start = blocks.length;
    let total = 0;

    for (let i = blocks.length - 1; i >= 0; i--) {
        const next = blocks[i].length;
        if (total + next > remaining) {
            break;
        }
        total += next;
        start = i;
    }

    const history = start < blocks.length ? blocks.slice(start).join('') : '';
    const historyBlock = history
        ? `Previous ticks (oldest to newest):${history}`
        : 'Previous ticks: none';

    const finalInstruction = renderMovementInstruction(finalInstructionTemplate, allowedActions, maxActionsPerTick);

    let stuckBlock = '';
    if (entries.length > 0) {
        const lastEntry = entries[entries.length - 1];
        if (lastEntry.captionFull === currentCaption) {
            stuckBlock = '\nNote: You are currently stuck and cannot move forward, try turning in a direction without obstruction.';
        }
    }

    return `${header}\n\n${historyBlock}\n\n${currentBlock}\n\n${objectiveBlock}\n\n${finalInstruction}${availableDirsNote}${stuckBlock}`;
}

const cores = {
    'Nintendo 64': 'n64',
    'Nintendo Game Boy / Color': 'gb',
    'Nintendo Game Boy Advance': 'gba',
    'Nintendo DS': 'nds',
    'Nintendo Entertainment System': 'fceumm',
    'Super Nintendo Entertainment System': 'snes',
    'PlayStation': 'psx',
    'Virtual Boy': 'vb',
    'Sega Mega Drive': 'segaMD',
    'Sega Master System': 'segaMS',
    'Sega CD': 'segaCD',
    'Atari Lynx': 'lynx',
    'Sega 32X': 'sega32x',
    'Atari Jaguar': 'jaguar',
    'Sega Game Gear': 'segaGG',
    'Sega Saturn': 'segaSaturn',
    'Atari 7800': 'atari7800',
    'Atari 2600': 'atari2600',
    'Arcade': 'arcade',
    'NEC TurboGrafx-16/SuperGrafx/PC Engine': 'pce',
    'NEC PC-FX': 'pcfx',
    'SNK NeoGeo Pocket (Color)': 'ngp',
    'Bandai WonderSwan (Color)': 'ws',
    'ColecoVision': 'coleco',
    'Commodore 64': 'vice_x64sc',
    'Commodore 128': 'vice_x128',
    'Commodore VIC20': 'vice_xvic',
    'Commodore Plus/4': 'vice_xplus4',
    'Commodore PET': 'vice_xpet',
};

function getAspectRatio(core) {
    switch (core) {
        case 'snes':
            return '4/3';
        case 'segaMD':
        case 'fceumm':
        case 'segaMS':
            return '13/10';
        case 'gba':
            return '3/2';
        case 'gb':
        case 'segaGG':
            return '10/9';
        case 'lynx':
            return '160/102';
    }

    return '4/3';
}

function tryGetCore(ext) {
    if (['fds', 'nes', 'unif', 'unf'].includes(ext))
        return 'fceumm';

    if (['smc', 'fig', 'sfc', 'gd3', 'gd7', 'dx2', 'bsx', 'swc'].includes(ext))
        return 'snes';

    if (['iso', 'bin', 'chd', 'cue', 'ccd', 'mds', 'mdf', 'pbp', 'cbn', 'nrg', 'cdi', 'gdi', 'cue', 'cd'].includes(ext))
        return 'psx';

    if (['gen', 'bin', 'smd', 'md'].includes(ext))
        return 'segaMD';

    if (['sms'].includes(ext))
        return 'segaMS';

    if (['vb'].includes(ext))
        return 'vb';

    if (['lynx', 'lnx'].includes(ext))
        return 'lynx';

    if (['32x'].includes(ext))
        return 'sega32x';

    if (['j64', 'jag'].includes(ext))
        return 'jaguar';

    if (['gg'].includes(ext))
        return 'segaGG';

    if (['gbc'].includes(ext))
        return 'gb';

    if (['z64', 'n64'].includes(ext))
        return 'n64';

    if (['pce'].includes(ext))
        return 'pce';

    if (['ngp', 'ngc'].includes(ext))
        return 'ngp';

    if (['ws', 'wsc'].includes(ext))
        return 'ws';

    if (['col', 'cv'].includes(ext))
        return 'coleco';

    if (['d64'].includes(ext))
        return 'vice_x64';

    if (['nds', 'gba', 'gb', 'z64', 'n64'].includes(ext))
        return ext;
}

function getSlug() {
    return Date.now().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

/**
 * Generates a description of the image using OpenAI API.
 * @param {string} base64Img  Base64-encoded image
 * @returns {Promise<string>} Generated description
 */
async function generateCaption(base64Img) {
    const useExisting = extension_settings.mazegame.movementUseCaptionPrompt !== false;
    const captionPromptTemplate = useExisting
        ? (extension_settings.mazegame.captionPrompt || defaultSettings.captionPrompt)
        : defaultSettings.captionPrompt;
    const captionPrompt = substituteParamsExtended(captionPromptTemplate, { game: currentGame, core: currentCore });

    const caption = await getMultimodalCaption(base64Img, captionPrompt);
    return caption;
}

/**
 * Generate a character response for the provided game screenshot.
 * @param {string} base64Img  Base64-encoded image
 */
async function provideComment(base64Img) {
    const chatId = getCurrentChatId();
    console.debug('provideComment: got frame image');

    recordAudioTelemetryEvent({ type: 'commentary_requested' });

    const caption = await generateCaption(base64Img);

    if (!caption) {
        recordAudioTelemetryEvent({ type: 'commentary_error', stage: 'caption', error: 'caption_empty' });
        return console.error('provideComment: failed to generate caption');
    }

    if (chatId !== getCurrentChatId()) {
        return console.log('provideComment: chat changed, skipping');
    }

    const useExisting = extension_settings.mazegame.movementUseCommentPrompt !== false;
    const commentPromptTemplate = useExisting
        ? (extension_settings.mazegame.commentPrompt || defaultSettings.commentPrompt)
        : defaultSettings.commentPrompt;
    const commentPrompt = substituteParamsExtended(commentPromptTemplate, { caption: caption, game: currentGame, core: currentCore });

    setCommentaryPrompt(commentPrompt);
    recordAudioTelemetryEvent({ type: 'commentary_generated' });
    await triggerCommentaryGeneration();
}

async function drawGameList() {
    const games = [];
    await gameStore.iterate((value, key) => {
        const id = String(DOMPurify.sanitize(key));
        const name = String(DOMPurify.sanitize(value.name));
        const core = String(DOMPurify.sanitize(value.core));

        games.push({ id, name, core });
    });

    games.sort((a, b) => { return a.core.localeCompare(b.core) || a.name.localeCompare(b.name); });

    const gameList = $('#mazegame_game_list');
    gameList.empty();

    if (games.length === 0) {
        gameList.append('<div class="wide100p textAlignCenter">No ROMs found.</div>');
        return;
    }

    for (const game of games) {
        gameList.append(`
        <div class="flex-container alignitemscenter">
            <div title="Launch the game" class="emulatorjs_play fa-solid fa-play menu_button" game-id="${game.id}"></div>
            <span class="emulatorjs_rom_name flex1" title="${game.name}">${game.name}</span>
            <small>${game.core}</small>
            <div title="Delete the game" class="emulatorjs_delete fa-solid fa-trash menu_button" game-id="${game.id}"></div>
        </div>`);
    }
}

function getCoreName(core) {
    return Object.keys(cores).find(key => cores[key] === core) || core;
}

async function onGameFileSelect() {
    const file = this.files[0];
    const parts = file.name.split('.');
    const ext = parts.pop();
    let name = parts.join('.');
    let core = tryGetCore(ext) || 'nes';
    let bios = '';
    let biosFileName = '';

    const popupText = `
        <div>
            <h4>Core</h4>
            <select id="mazegame_cores" class="text_pole wide100p"></select>
            <h4>Name</h4>
            <textarea id="mazegame_name" type="text" class="text_pole wide100p" placeholder="<Name>" rows="2"></textarea>
            <h4>BIOS (optional)</h4>
            <input id="mazegame_bios" type="file" class="text_pole wide100p" placeholder="<BIOS>" />
            <div class="emulatorjs_bios_info">
                Some cores require a BIOS file to work.<br>
                Please check the <a href="${docUrl}" target="_blank">documentation</a> of the core you selected.
            </div>
        </div>`;

    const popupInstance = $(popupText);
    const coreSelect = popupInstance.find('#mazegame_cores');
    const nameInput = popupInstance.find('#mazegame_name');
    const biosInput = popupInstance.find('#mazegame_bios');

    coreSelect.on('input change', () => {
        core = coreSelect.val();
    });

    nameInput.on('input change', () => {
        name = nameInput.val();
    });

    biosInput.on('change', async () => {
        const biosFile = biosInput.prop('files')[0];
        biosFileName = biosFile?.name || '';
        bios = await readAsArrayBuffer(biosFile);
    });

    for (const [key, value] of Object.entries(cores).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))) {
        const option = document.createElement('option');
        option.innerText = key;
        option.value = value;
        option.selected = value === core;
        coreSelect.append(option);
    }

    nameInput.val(name).trigger('input');
    coreSelect.val(core).trigger('change');

    const confirm = await callGenericPopup(popupInstance, POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel' });

    if (!confirm) {
        return;
    }

    const data = await readAsArrayBuffer(file);

    const slug = `emulatorjs-${getSlug()}`;

    const game = {
        id: slug,
        name: name,
        core: core,
        fileName: file.name,
        data: data,
        biosFileName: biosFileName,
        bios: bios,
    };

    await gameStore.setItem(slug, game);
    await drawGameList();
}

async function readAsArrayBuffer(file) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            resolve(event.target.result);
        };
        reader.onerror = (event) => {
            reject(event.target.error);
        };

        reader.readAsArrayBuffer(file);
    });
}

/**
 * Starts the game comment worker.
 * @param {HTMLIFrameElement} frameElement Host frame element
 */
async function setupCommentWorker(frameElement) {
    if (!getCurrentChatId()) {
        return console.log('provideComment: no chat selected, skipping');
    }

    try {
        // Wait for the emulator object/canvas to be initialized
        await waitUntilCondition(() => {
            const ejsCanvas = frameElement.contentWindow?.EJS_emulator?.canvas;
            const domCanvas = frameElement.contentDocument?.querySelector('canvas');
            return ejsCanvas || domCanvas;
        }, 15000);

        const emulatorObject = frameElement.contentWindow?.EJS_emulator;
        const emulatorCanvas = /** @type {HTMLCanvasElement} */ (
            emulatorObject?.canvas || frameElement.contentDocument?.querySelector('canvas')
        );

        if (!emulatorCanvas) {
            throw new Error('Failed to get the emulator canvas.');
        }

        const frameGrabber = await createFrameGrabber(emulatorCanvas);
        if (frameGrabber.mode === 'canvas') {
            toastr.info('ImageCapture unavailable. Using canvas fallback capture mode.', 'MazeGame');
        }

        const updateMs = getLegacyCommentIntervalSeconds() * 1000;
        if (updateMs <= 0) {
            console.log('provideComment: legacy interval is 0, not starting worker.');
            return;
        }

        // If the video track is ended, stop the worker
        frameGrabber.videoTrack?.addEventListener('ended', () => {
            clearTimeout(commentTimer);
            clearCommentaryPrompt();
            return console.log('provideComment: video ended, stopping comment worker.');
        });

        // If the chat is changed, stop the worker
        eventSource.once(event_types.CHAT_CHANGED, () => {
            clearTimeout(commentTimer);
            clearCommentaryPrompt();
            return console.log('provideComment: chat changed, stopping comment worker.');
        });

        const shouldStopWorker = () => frameGrabber.videoTrack?.readyState === 'ended' || getLegacyCommentIntervalSeconds() === 0;

        const doUpdate = async () => {
            try {
                console.log(`provideComment: entered at ${new Date().toISOString()}`);

                // Check if the video track is not ended
                if (shouldStopWorker()) {
                    return console.log('provideComment: video track ended');
                }

                // Check if the document is focused
                if (!document.hasFocus()) {
                    return console.log('provideComment: document not focused');
                }

                // Check if the emulator is running
                if (emulatorObject?.paused === true) {
                    return console.log('provideComment: emulator paused');
                }

                // Grab a frame from the video track
                console.debug('provideComment: grabbing frame');
                const bitmap = await frameGrabber.grabFrame();

                // Draw frame to canvas
                console.debug('provideComment: drawing frame to canvas');
                if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    console.debug(`provideComment: resizing canvas to ${bitmap.width}x${bitmap.height}`);
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                }
                const context = canvas.getContext('2d');
                // Ensure the pixels stay crisp
                context.imageSmoothingEnabled = false;
                context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

                // Convert to base64 PNG string
                console.debug('provideComment: converting canvas to base64');
                const blob = await canvas.convertToBlob({ type: 'image/png', quality: 1 });
                const base64 = await getBase64Async(blob);

                // Send to worker
                console.debug('provideComment: sending image to worker');
                await commentWorker.update(base64);
                console.debug('provideComment: worker finished');
            } finally {
                // If the video track is ended, stop the worker
                if (shouldStopWorker()) {
                    clearTimeout(commentTimer);
                    clearCommentaryPrompt();
                    console.debug('provideComment: video ended, stopping comment worker.');
                } else {
                    // Schedule next update
                    commentTimer = setTimeout(doUpdate, updateMs);
                    const nextUpdate = new Date(Date.now() + updateMs).toISOString();
                    console.log(`provideComment: scheduled next update at ${nextUpdate}`);
                }
            }
        };

        // Start the worker
        const firstUpdate = new Date(Date.now() + updateMs).toISOString();
        console.log(`provideComment: starting comment worker, first update at ${firstUpdate}`);
        commentTimer = setTimeout(doUpdate, updateMs);
    } catch (error) {
        console.error('Failed to start comment worker.', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        toastr.warning(`Failed to start comment worker: ${message}`, 'MazeGame');
    }
}

async function createFrameGrabber(emulatorCanvas) {
    let videoTrack = null;
    let imageCapture = null;
    let mode = 'canvas';

    if ('ImageCapture' in window) {
        try {
            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            for (let i = 0; i < 8 && !videoTrack; i++) {
                const stream = emulatorCanvas.captureStream(1);
                [videoTrack] = stream.getVideoTracks();
                if (!videoTrack) {
                    await sleep(250);
                }
            }

            if (videoTrack) {
                imageCapture = new window.ImageCapture(videoTrack);
                mode = 'imagecapture';
            }
        } catch (error) {
            console.warn('ImageCapture unavailable, using canvas fallback capture.', error);
            videoTrack = null;
            imageCapture = null;
            mode = 'canvas';
        }
    }

    return {
        mode,
        videoTrack,
        async grabFrame() {
            if (imageCapture) {
                return imageCapture.grabFrame();
            }
            return emulatorCanvas;
        },
    };
}

function parseAiActionPlan(text, allowedActions, maxActionsPerTick) {
    const raw = String(text || '').toUpperCase();
    const limit = Math.max(1, Number(maxActionsPerTick) || 1);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]);
        if (Array.isArray(obj.actions)) {
            const seq = obj.actions
                .map(x => String(x || '').toUpperCase())
                .filter(x => allowedActions.includes(x))
                .slice(0, limit);
            if (seq.length) return seq;
        }
      } catch {}
    }

    const tokens = raw
        .split(/[^A-Z0-9_]+/)
        .map(x => x.trim())
        .filter(Boolean);

    const out = [];
    for (const t of tokens) {
        if (!allowedActions.includes(t)) continue;
        out.push(t);
        if (out.length >= limit) break;
    }

    return out;
}

function fallbackAiAction(tick, allowedActions) {
    if (!allowedActions.length) {
        return 'UP';
    }

    const cfg = getMovementConfig();
    if (cfg.fallbackMode === 'random') {
        return allowedActions[Math.floor(Math.random() * allowedActions.length)];
    }

    const ordered = AI_ACTION_ORDER.filter(x => allowedActions.includes(x));
    const pool = ordered.length ? ordered : allowedActions;
    return pool[tick % pool.length];
}

async function chooseMovementAction(base64Img, tick, allowedActions, maxActionsPerTick) {
    try {
        let caption = '';
        try {
            caption = await generateCaption(base64Img);
        } catch (captionError) {
            console.warn('Movement caption failed, using fallback decision context.', captionError);
        }

        const cfg = getMovementConfig();
        const prompt = buildMovementPromptFromMemory(caption || 'No caption available.', allowedActions, maxActionsPerTick, cfg.finalInstruction, tick);
        const reply = await generateMovementDecisionText(prompt, cfg);
        const parsed = parseAiActionPlan(reply, allowedActions, maxActionsPerTick);
        const actions = parsed.length ? parsed : [fallbackAiAction(tick, allowedActions)];
        return {
            actions,
            caption: caption || 'No caption available.',
        };
    } catch (error) {
        console.warn('chooseMovementAction failed, using fallback action', error);
        const action = [fallbackAiAction(tick, allowedActions)];
        return {
            actions: action,
            caption: 'No caption available (generation failure).',
        };
    }
}

function pickLoopBreakDirection(loopAction, allowedActions) {
    const loopPrimary = String(loopAction || '').split(',')[0].trim().toUpperCase();
    const candidates = allowedActions
        .filter(action => DPAD_ACTIONS.includes(action))
        .filter(action => action !== loopPrimary);
    if (!candidates.length) {
        return null;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function sendActionTap(frameElement, player, action, holdMs = MOVEMENT_HOLD_MS) {
    const index = ACTION_INDEX[action];
    if (typeof index !== 'number') {
        return;
    }

    frameElement.contentWindow?.postMessage({
        type: 'EJS_INPUT_TAP',
        player,
        index,
        holdMs,
    }, '*');
}

async function executeActionSequence(frameElement, player, actions, holdMs, stepDelayMs) {
    const seq = Array.isArray(actions) ? actions : [actions];
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < seq.length; i++) {
        sendActionTap(frameElement, player, seq[i], holdMs);
        if (i < seq.length - 1) {
            await sleep(stepDelayMs);
        }
    }
}

async function setupCoopMovementWorker(frameElement) {
    const cfg = getMovementConfig();
    if (!cfg.enabled) {
        console.log('AI movement co-op disabled in settings.');
        return;
    }

    try {
        beginMovementSession('coop-start');
        await waitUntilCondition(() => {
            const ejsCanvas = frameElement.contentWindow?.EJS_emulator?.canvas;
            const domCanvas = frameElement.contentDocument?.querySelector('canvas');
            return ejsCanvas || domCanvas;
        }, 15000);

        const emulatorObject = frameElement.contentWindow?.EJS_emulator;
        const emulatorCanvas = /** @type {HTMLCanvasElement} */ (
            emulatorObject?.canvas || frameElement.contentDocument?.querySelector('canvas')
        );

        if (!emulatorCanvas) {
            throw new Error('Failed to get emulator canvas for AI movement worker.');
        }

        const frameGrabber = await createFrameGrabber(emulatorCanvas);
        if (frameGrabber.mode === 'canvas') {
            toastr.info('ImageCapture unavailable. Using canvas fallback capture mode.', 'MazeGame');
        }

        let tick = 0;
        let previousActionText = '';
        let sameActionStreak = 0;
        movementTickCounter = 0;
        movementLastAction = '-';
        updateMovementDebugUI();

        const onFrameMessage = (event) => {
            if (event.source !== frameElement.contentWindow) return;
            if (event.data?.type === 'EJS_SESSION_RESTART') {
                beginMovementSession('core-restart');
                previousActionText = '';
                sameActionStreak = 0;
                movementTickCounter = 0;
                movementLastAction = '-';
                updateMovementDebugUI();
                toastr.info('AI session memory reset for game restart.', 'MazeGame');
                return;
            }

            if (event.data?.type === 'MAZE_OBJECTIVE_STATE') {
                const rawLayout = event.data?.layout;
                const safeLayout = rawLayout && typeof rawLayout === 'object'
                    ? {
                        strategy: String(rawLayout.strategy || ''),
                        alcoveCount: Number.isFinite(Number(rawLayout.alcoveCount)) ? Number(rawLayout.alcoveCount) : null,
                        key: rawLayout.key && typeof rawLayout.key === 'object'
                            ? {
                                x: Number.isFinite(Number(rawLayout.key.x)) ? Number(rawLayout.key.x) : null,
                                y: Number.isFinite(Number(rawLayout.key.y)) ? Number(rawLayout.key.y) : null,
                                faceDir: Number.isFinite(Number(rawLayout.key.faceDir)) ? Number(rawLayout.key.faceDir) : null,
                            }
                            : null,
                        door: rawLayout.door && typeof rawLayout.door === 'object'
                            ? {
                                x: Number.isFinite(Number(rawLayout.door.x)) ? Number(rawLayout.door.x) : null,
                                y: Number.isFinite(Number(rawLayout.door.y)) ? Number(rawLayout.door.y) : null,
                                faceDir: Number.isFinite(Number(rawLayout.door.faceDir)) ? Number(rawLayout.door.faceDir) : null,
                            }
                            : null,
                    }
                    : null;
                mazeObjectiveState = {
                    text: String(event.data?.objective || mazeObjectiveState.text || ''),
                    status: String(event.data?.status || mazeObjectiveState.status || 'active'),
                    hint: String(event.data?.hint || ''),
                    interactAvailable: !!event.data?.interactAvailable,
                    doorInteractable: !!event.data?.doorInteractable,
                    availableActions: event.data?.availableActions || [],
                    layout: safeLayout,
                };
            }
        };
        window.addEventListener('message', onFrameMessage);

        frameGrabber.videoTrack?.addEventListener('ended', () => {
            clearTimeout(movementTimer);
            clearTimeout(commentTimer);
            window.removeEventListener('message', onFrameMessage);
            endMovementSession();
            console.log('AI movement worker stopped: video ended.');
        });

        if (cfg.stopOnChatChange) {
            eventSource.once(event_types.CHAT_CHANGED, () => {
                clearTimeout(movementTimer);
                clearTimeout(commentTimer);
                window.removeEventListener('message', onFrameMessage);
                endMovementSession();
                console.log('AI movement worker stopped: chat changed.');
            });
        }

        const shouldStop = () => frameGrabber.videoTrack?.readyState === 'ended';

        const loop = async () => {
            try {
                const tickNumber = tick + 1;
                toastr.info(`AI movement tick ${tickNumber} started.`, 'MazeGame');

                if (shouldStop()) {
                    toastr.warning(`AI movement tick ${tickNumber} skipped: stream ended.`, 'MazeGame');
                    return;
                }

                if (cfg.stopWhenPaused && emulatorObject?.paused === true) {
                    toastr.warning(`AI movement tick ${tickNumber} skipped: emulator paused.`, 'MazeGame');
                    return;
                }

                const bitmap = await frameGrabber.grabFrame();

                if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                }

                const context = canvas.getContext('2d');
                context.imageSmoothingEnabled = false;
                context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

                const blob = await canvas.convertToBlob({ type: 'image/png', quality: 1 });
                const base64 = await getBase64Async(blob);

                const decision = await chooseMovementAction(base64, tick, cfg.allowedActions, cfg.maxActionsPerTick);
                let actions = Array.isArray(decision.actions) ? [...decision.actions] : [fallbackAiAction(tick, cfg.allowedActions)];
                let actionText = actions.join(',');
                let loopBreak = false;
                let loopOriginalAction = '';

                if (actionText && actionText === previousActionText) {
                    sameActionStreak += 1;
                } else {
                    sameActionStreak = 1;
                }

                if (cfg.loopBreakEnabled && sameActionStreak >= MOVEMENT_LOOP_BREAK_THRESHOLD) {
                    const forcedDirection = pickLoopBreakDirection(actionText, cfg.allowedActions);
                    if (forcedDirection) {
                        loopBreak = true;
                        loopOriginalAction = actionText;
                        actions = [forcedDirection];
                        actionText = forcedDirection;
                        sameActionStreak = 1;
                    }
                }

                await executeActionSequence(frameElement, cfg.player, actions, cfg.holdMs, cfg.stepDelayMs);
                addMovementMemoryEntry(tick + 1, decision.caption, actions, {
                    loopBreak,
                    loopStreak: loopBreak ? MOVEMENT_LOOP_BREAK_THRESHOLD : sameActionStreak,
                    loopOriginalAction,
                });
                toastr.success(`AI movement tick ${tickNumber}: ${actionText} sent.`, 'MazeGame');
                movementLastAction = actionText;
                previousActionText = actionText;
                movementTickCounter = tick + 1;
                updateMovementDebugUI();
                if (cfg.logDecisions) {
                    console.log(`[MazeGame] AI action tick ${movementTickCounter}: ${actionText}`);
                    if (loopBreak) {
                        console.log(`[MazeGame] Loop break injected at streak ${MOVEMENT_LOOP_BREAK_THRESHOLD}: ${loopOriginalAction} -> ${actionText}`);
                    }
                }

                tick++;

                if (cfg.commentEnabled && tick % cfg.commentEveryTicks === 0) {
                    await commentWorker.update(base64);
                }
            } finally {
                if (shouldStop()) {
                    window.removeEventListener('message', onFrameMessage);
                    endMovementSession();
                    clearTimeout(movementTimer);
                    clearTimeout(commentTimer);
                } else {
                    movementTimer = setTimeout(loop, cfg.intervalMs);
                }
            }
        };

        movementTimer = setTimeout(loop, cfg.startupDelayMs);
        console.log(`AI movement worker started: ${cfg.intervalMs / 1000}s ticks, hold ${cfg.holdMs}ms, comment every ${cfg.commentEveryTicks} ticks.`);
    } catch (error) {
        endMovementSession();
        console.error('Failed to start AI movement worker.', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        toastr.warning(`Failed to start AI movement worker: ${message}`, 'MazeGame');
    }
}

async function startEmulator() {
    const slug = 'mazegame-frame-' + getSlug();
    const context = getContext();
    const game = {
        id: slug,
        name: 'MazeGame',
        core: 'html5-maze',
        seed: Math.floor(Math.random() * 1000000000),
        autoNextMaze: true,
    };

    context.sendSystemMessage('generic', slug);

    if (Array.isArray(context.chat)) {
        for (const message of context.chat) {
            if (message.mes == slug) {
                message.mes = `[MazeGame: ${context.name1} launches ${game.name}]`;
                break;
            }
        }
    }

    const slugMessage = $('#chat .last_mes');
    const slugMessageText = slugMessage.find('.mes_text');
    if (!slugMessageText.text().includes(slug)) {
        toastr.error('Failed to start MazeGame. Please try again.');
        return;
    }

    slugMessage.removeClass('last_mes');
    currentGame = game.name;
    currentCore = game.core;
    currentGameSeed = game.seed;
    const runtimeUrl = `${baseUrl}?v=${Date.now()}`;
    const frame = `<iframe id="${slug}" class="mazegame_frame" src="${runtimeUrl}" allow="autoplay; fullscreen"></iframe>`;
    const frameInstance = $(frame);
    frameInstance.css('aspect-ratio', '16 / 9');
    slugMessageText.empty().append(frameInstance);

    const order = (10000 + gamesLaunched++).toFixed(0);
    slugMessage.css('order', order);

    frameInstance.on('load', async () => {
        const frameElement = frameInstance[0];
        if (!(frameElement instanceof HTMLIFrameElement)) return;
        
        // Let the frame set its own ID to be picked up by sendShaderSettingsToEmulator
        frameElement.id = 'mazegame_frame';
        sendShaderSettingsToEmulator();
        
        frameElement.contentWindow?.postMessage({ type: 'MAZE_INIT', game }, '*');
        clearTimeout(commentTimer);
        clearTimeout(movementTimer);
        clearCommentaryPrompt();

        if (getRuntimeMode() === 'legacy') {
            await setupCommentWorker(frameElement);
        } else {
            await setupCoopMovementWorker(frameElement);
        }
    });

    frameInstance.on('unload', () => {
        clearTimeout(commentTimer);
        clearTimeout(movementTimer);
        endMovementSession();
        clearCommentaryPrompt();
    });

    $('#chat').scrollTop($('#chat')[0].scrollHeight);
}

jQuery(async () => {
    if (!extension_settings.mazegame) {
        extension_settings.mazegame = structuredClone(defaultSettings);
        if (extension_settings.emulatorjs) {
            Object.assign(extension_settings.mazegame, extension_settings.emulatorjs);
        }
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.mazegame[key] === undefined) {
            extension_settings.mazegame[key] = defaultSettings[key];
        }
    }

    if (!Array.isArray(extension_settings.mazegame.movementAllowedActions)) {
        extension_settings.mazegame.movementAllowedActions = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER'];
    } else {
        const normalized = extension_settings.mazegame.movementAllowedActions
            .map(x => String(x || '').toUpperCase())
            .filter(x => MOVEMENT_ALLOWED_ACTIONS.includes(x));
        if (!normalized.includes('ENTER')) normalized.push('ENTER');
        extension_settings.mazegame.movementAllowedActions = [...new Set(normalized)];
    }

    if (extension_settings.mazegame.legacyCommentIntervalSeconds === undefined) {
        extension_settings.mazegame.legacyCommentIntervalSeconds = clampNumber(extension_settings.mazegame.commentInterval, 0, 0, 6000);
    }
    extension_settings.mazegame.commentInterval = clampNumber(extension_settings.mazegame.legacyCommentIntervalSeconds, 0, 0, 6000);

    runOneTimeMansionProfileMigration();
    ensureAudioTelemetryState();

    if (!window.__ejsNextAudioTelemetryBound) {
        window.addEventListener('message', onWindowAudioTelemetryMessage);
        window.__ejsNextAudioTelemetryBound = true;
    }

    clearCommentaryPrompt();

    const button = $(`
    <div id="mazegame_start" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <div class="fa-solid fa-gamepad" title="Start a new game in the emulator"/></div>
        Play MazeGame
    </div>`);

    const getWandContainer = () => $(document.getElementById('mazegame_wand_container') ?? document.getElementById('extensionsMenu'));
    const wandContainer = getWandContainer();
    wandContainer.attr('tabindex', '0');
    wandContainer.addClass('interactable');
    wandContainer.append(button);

    if (!document.getElementById('mazegame_settings_style')) {
        $('head').append(`<style id="mazegame_settings_style">
            .mazegame_settings .inline-drawer-content { padding-top: 8px; }
            .mazegame_settings .mg-stack { display: grid; gap: 10px; }
            .mazegame_settings .mg-card { border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.16)); border-radius: 8px; background: transparent; padding: 10px; display: grid; gap: 6px; }
            .mazegame_settings .mg-title { font-weight: 700; font-size: 0.95rem; margin: 0 0 2px 0; }
            .mazegame_settings .mg-sub { opacity: 0.78; font-size: 0.85em; margin-bottom: 4px; }
            .mazegame_settings .mg-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
            .mazegame_settings .mg-grid2 > div { display: grid; gap: 4px; min-width: 0; }
            .mazegame_settings .mg-grid2 .checkbox_label { margin-top: 2px; }
            .mazegame_settings .mg-actions { display: flex; gap: 8px; flex-wrap: wrap; }
            .mazegame_settings #mazegame_allowed_actions { min-height: 150px; }
            @media (max-width: 900px) { .mazegame_settings .mg-grid2 { grid-template-columns: 1fr; } }
        </style>`);
    }

    const settings = `
    <div class="mazegame_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>MazeGame</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="mg-stack">
                    <div class="mg-card">
                        <div class="mg-title">Runtime</div>
                        <div class="mg-grid2">
                            <div>
                                <label for="mazegame_runtime_mode">Mode</label>
                                <select id="mazegame_runtime_mode" class="text_pole wide100p">
                                    <option value="coop">Co-op Movement</option>
                                    <option value="legacy">Legacy Commentary</option>
                                </select>
                            </div>
                            <div>
                                <label>Status</label>
                                <small id="mazegame_runtime_active">Active: Co-op Movement</small>
                            </div>
                        </div>
                    </div>

                    <div id="mazegame_coop_section" class="mg-stack wide100p">
                        <div class="mg-card">
                            <div class="mg-title">AI Movement Core</div>
                            <label for="mazegame_movement_enabled" class="checkbox_label"><input id="mazegame_movement_enabled" type="checkbox" /><span>Enable AI Movement Co-op</span></label>
                            <div class="mg-grid2">
                                <div>
                                    <label for="mazegame_movement_player">AI Controls Player</label>
                                    <select id="mazegame_movement_player" class="text_pole wide100p"><option value="0">P1</option><option value="1">P2</option></select>
                                </div>
                                <div>
                                    <label for="mazegame_movement_api_server">Movement KoboldCpp Server URL</label>
                                    <input id="mazegame_movement_api_server" type="text" class="text_pole wide100p" placeholder="http://127.0.0.1:5001" />
                                </div>
                            </div>
                            <small class="mg-sub">UP=Forward, LEFT=Rotate Left, RIGHT=Rotate Right, DOWN=Turn Around, ENTER=Interact</small>
                            <label for="mazegame_allowed_actions">Allowed AI Buttons</label>
                            <small class="mg-sub">MazeGame supports D-pad + ENTER interaction.</small>
                            <select id="mazegame_allowed_actions" class="text_pole wide100p" multiple size="8">
                                <option value="UP">UP</option><option value="DOWN">DOWN</option><option value="LEFT">LEFT</option><option value="RIGHT">RIGHT</option><option value="ENTER">ENTER</option>
                            </select>
                        </div>

                        <div class="mg-card">
                            <div class="mg-title">Timing</div>
                            <div class="mg-grid2">
                                <div><label for="mazegame_movement_interval">Decision Interval (seconds)</label><input id="mazegame_movement_interval" type="number" class="text_pole wide100p" value="20" min="0" max="3600" step="1" /></div>
                                <div><label for="mazegame_movement_hold">Direction Hold (ms)</label><input id="mazegame_movement_hold" type="number" class="text_pole wide100p" value="200" min="50" max="1000" step="10" /></div>
                                <div><label for="mazegame_movement_step_delay">Inter-step Delay (ms)</label><input id="mazegame_movement_step_delay" type="number" class="text_pole wide100p" value="150" min="0" max="2000" step="10" /></div>
                                <div><label for="mazegame_movement_max_actions">Actions Per Tick (max)</label><input id="mazegame_movement_max_actions" type="number" class="text_pole wide100p" value="4" min="1" max="12" step="1" /></div>
                                <div><label for="mazegame_movement_start_delay">Startup Delay (seconds)</label><input id="mazegame_movement_start_delay" type="number" class="text_pole wide100p" value="20" min="0" max="120" step="1" /></div>
                                <div>
                                    <label for="mazegame_movement_temperature">Temperature <span id="mazegame_movement_temp_value">0.2</span></label>
                                    <input id="mazegame_movement_temperature" type="range" class="wide100p" min="0" max="2" step="0.1" value="${defaultSettings.movementSamplerTemperature}" />
                                    <small class="mg-sub">Higher = more creative/random choices</small>
                                </div>
                            </div>
                        </div>

                        <div class="mg-card">
                            <div class="mg-title">Prompting</div>
                            <label for="mazegame_movement_system_prompt">Movement System Prompt</label>
                            <textarea id="mazegame_movement_system_prompt" type="text" class="text_pole textarea_compact wide100p" rows="2">${defaultSettings.movementSystemPrompt}</textarea>
                            <label for="mazegame_movement_final_instruction">Movement Final Instruction</label>
                            <small class="mg-sub">Supports: <code>{{max}}</code>, <code>{{allowed}}</code>, <code>{{game}}</code>, <code>{{core}}</code></small>
                            <textarea id="mazegame_movement_final_instruction" type="text" class="text_pole textarea_compact wide100p" rows="2">${defaultSettings.movementFinalInstruction}</textarea>
                            <div class="mg-grid2">
                                <div><label for="mazegame_movement_comment_every">Comment Every N Ticks</label><input id="mazegame_movement_comment_every" type="number" class="text_pole wide100p" value="4" min="1" max="20" step="1" /></div>
                                <div style="display:grid;gap:4px;align-content:center;">
                                    <label for="mazegame_movement_comment_enabled" class="checkbox_label"><input id="mazegame_movement_comment_enabled" type="checkbox" /><span>Post Participation Comment</span></label>
                                    <label for="mazegame_use_comment_prompt" class="checkbox_label"><input id="mazegame_use_comment_prompt" type="checkbox" /><span>Use Existing Comment Prompt</span></label>
                                    <label for="mazegame_use_caption_prompt" class="checkbox_label"><input id="mazegame_use_caption_prompt" type="checkbox" /><span>Use Existing Caption Prompt</span></label>
                                </div>
                            </div>
                        </div>

                        <div class="mg-card">
                            <div class="mg-title">Reliability / Safety</div>
                            <div class="mg-grid2">
                                <div>
                                    <label for="mazegame_movement_fallback">Invalid Output Fallback</label>
                                    <select id="mazegame_movement_fallback" class="text_pole wide100p"><option value="clockwise">Clockwise</option><option value="random">Random</option></select>
                                </div>
                                <div style="display:grid;gap:4px;align-content:center;">
                                    <label for="mazegame_movement_stop_chat" class="checkbox_label"><input id="mazegame_movement_stop_chat" type="checkbox" /><span>Stop AI On Chat Change</span></label>
                                    <label for="mazegame_movement_stop_pause" class="checkbox_label"><input id="mazegame_movement_stop_pause" type="checkbox" /><span>Stop AI When Emulator Paused</span></label>
                                </div>
                            </div>
                        </div>

                        <div class="mg-card">
                            <div class="mg-title">Shader Effects</div>
                            <div class="mg-grid2">
                                <div><label for="mazegame_shader_scanline">Scanline Strength</label><input id="mazegame_shader_scanline" type="number" class="text_pole wide100p" value="${defaultSettings.shaderScanlineStrength}" min="0" max="1" step="0.01" /></div>
                                <div><label for="mazegame_shader_dither">Dither Strength</label><input id="mazegame_shader_dither" type="number" class="text_pole wide100p" value="${defaultSettings.shaderDitherStrength}" min="0" max="2" step="0.05" /></div>
                                <div><label for="mazegame_shader_color_steps">Color Steps (Banding)</label><input id="mazegame_shader_color_steps" type="number" class="text_pole wide100p" value="${defaultSettings.shaderColorSteps}" min="2" max="256" step="1" /></div>
                                <div><label for="mazegame_shader_vignette">Vignette Alpha</label><input id="mazegame_shader_vignette" type="number" class="text_pole wide100p" value="${defaultSettings.shaderVignette}" min="0" max="1" step="0.05" /></div>
                            </div>
                        </div>

                        <div class="mg-card">
                            <div class="mg-title">Debug & Logs</div>
                            <label for="mazegame_show_last_dir" class="checkbox_label"><input id="mazegame_show_last_dir" type="checkbox" /><span>Show Last AI Action</span></label>
                            <small id="mazegame_last_direction_wrap" style="display:none">Last action: <code id="mazegame_last_direction">-</code></small>
                            <label for="mazegame_show_tick_counter" class="checkbox_label"><input id="mazegame_show_tick_counter" type="checkbox" /><span>Show Tick Counter</span></label>
                            <small id="mazegame_tick_counter_wrap" style="display:none">Tick counter: <code id="mazegame_tick_counter">0</code></small>
                            <label for="mazegame_log_decisions" class="checkbox_label"><input id="mazegame_log_decisions" type="checkbox" /><span>Log Decisions to Console</span></label>
                            <label for="mazegame_loop_break_enabled" class="checkbox_label"><input id="mazegame_loop_break_enabled" type="checkbox" /><span>Repetition Correction (anti-stuck)</span></label>
                            <div class="mg-actions"><button id="mazegame_export_logs_json" class="menu_button" type="button">Export Movement Logs (JSON)</button></div>
                        </div>
                    </div>

                    <div id="mazegame_legacy_section" class="mg-card wide100p">
                        <div class="mg-title">Legacy Commentary</div>
                        <small class="mg-sub">Set to 0 to disable legacy commentary worker.</small>
                        <label for="mazegame_legacy_interval">Legacy Comment Interval (seconds)</label>
                        <input id="mazegame_legacy_interval" type="number" class="text_pole wide100p" value="0" min="0" step="1" max="6000" />
                    </div>

                    <div class="mg-card">
                        <div class="mg-title">Caption / Comment Prompts</div>
                        <label for="mazegame_caption_prompt">Caption Prompt</label>
                        <small class="mg-sub">Used to describe the image when multimodal captioning runs. Supports <code>{{game}}</code> and <code>{{core}}</code>.</small>
                        <textarea id="mazegame_caption_prompt" type="text" class="text_pole textarea_compact wide100p" rows="3">${defaultSettings.captionPrompt}</textarea>
                        <label for="mazegame_comment_prompt">Comment Prompt</label>
                        <small class="mg-sub">Supports <code>{{game}}</code>, <code>{{core}}</code> and <code>{{caption}}</code>.</small>
                        <textarea id="mazegame_comment_prompt" type="text" class="text_pole textarea_compact wide100p" rows="4">${defaultSettings.commentPrompt}</textarea>
                        <label for="mazegame_force_captions" class="checkbox_label"><input id="mazegame_force_captions" type="checkbox" /><span>Force captions</span></label>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    const getContainer = () => $(document.getElementById('mazegame_container') ?? document.getElementById('extensions_settings2'));
    getContainer().append(settings);
    $('#mazegame_start').on('click', function () {
        startEmulator();
    });
    $('#mazegame_runtime_mode').val(getRuntimeMode());
    $('#mazegame_runtime_mode').on('input change', function () {
        const mode = String($(this).val());
        extension_settings.mazegame.runtimeMode = mode === 'legacy' ? 'legacy' : 'coop';
        updateRuntimeModeUI();
        saveSettingsDebounced();
    });
    $('#mazegame_legacy_interval').val(getLegacyCommentIntervalSeconds());
    $('#mazegame_legacy_interval').on('input change', function () {
        const v = clampNumber($(this).val(), 0, 0, 6000);
        extension_settings.mazegame.legacyCommentIntervalSeconds = v;
        extension_settings.mazegame.commentInterval = v;
        saveSettingsDebounced();
    });
    const allowedActions = getMovementConfig().allowedActions;
    $('#mazegame_allowed_actions option').each(function () {
        $(this).prop('selected', allowedActions.includes(String($(this).val()).toUpperCase()));
    });
    $('#mazegame_allowed_actions').on('input change', function () {
        const selected = $(this).val();
        const list = (Array.isArray(selected) ? selected : [])
            .map(x => String(x || '').toUpperCase())
            .filter(x => MOVEMENT_ALLOWED_ACTIONS.includes(x));
        extension_settings.mazegame.movementAllowedActions = [...new Set(list)];
        if (!extension_settings.mazegame.movementAllowedActions.length) {
            extension_settings.mazegame.movementAllowedActions = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER'];
            toastr.warning('No actions selected. Reset to UP, DOWN, LEFT, RIGHT, ENTER.', 'MazeGame');
            $('#mazegame_allowed_actions option').each(function () {
                const v = String($(this).val()).toUpperCase();
                $(this).prop('selected', ['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER'].includes(v));
            });
        }
        saveSettingsDebounced();
    });
    $('#mazegame_movement_api_server').val(extension_settings.mazegame.movementApiServerUrl || '');
    $('#mazegame_movement_api_server').on('input change', function () {
        extension_settings.mazegame.movementApiServerUrl = String($(this).val() || '').trim();
        saveSettingsDebounced();
    });
    $('#mazegame_movement_system_prompt').val(extension_settings.mazegame.movementSystemPrompt || defaultSettings.movementSystemPrompt);
    $('#mazegame_movement_system_prompt').on('input change', function () {
        extension_settings.mazegame.movementSystemPrompt = String($(this).val() || '').trim() || defaultSettings.movementSystemPrompt;
        saveSettingsDebounced();
    });
    $('#mazegame_movement_final_instruction').val(extension_settings.mazegame.movementFinalInstruction || defaultSettings.movementFinalInstruction);
    $('#mazegame_movement_final_instruction').on('input change', function () {
        extension_settings.mazegame.movementFinalInstruction = String($(this).val() || '').trim() || defaultSettings.movementFinalInstruction;
        saveSettingsDebounced();
    });
    $('#mazegame_movement_enabled').prop('checked', extension_settings.mazegame.movementEnabled);
    $('#mazegame_movement_enabled').on('input change', function () {
        extension_settings.mazegame.movementEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mazegame_movement_player').val(String(extension_settings.mazegame.movementPlayer ?? 0));
    $('#mazegame_movement_player').on('input change', function () {
        extension_settings.mazegame.movementPlayer = clampNumber($(this).val(), 0, 0, 1);
        saveSettingsDebounced();
    });
    const savedTemp = extension_settings.mazegame.movementSamplerTemperature ?? defaultSettings.movementSamplerTemperature;
    $('#mazegame_movement_temperature').val(savedTemp);
    $('#mazegame_movement_temp_value').text(savedTemp.toFixed(1));
    $('#mazegame_movement_temperature').on('input change', function () {
        const val = parseFloat($(this).val()) || 0.2;
        extension_settings.mazegame.movementSamplerTemperature = val;
        $('#mazegame_movement_temp_value').text(val.toFixed(1));
        saveSettingsDebounced();
    });
    $('#mazegame_movement_interval').val(extension_settings.mazegame.movementIntervalSeconds);
    $('#mazegame_movement_interval').on('input change', function () {
        extension_settings.mazegame.movementIntervalSeconds = clampNumber($(this).val(), 20, 0, 3600);
        saveSettingsDebounced();
    });
    $('#mazegame_movement_hold').val(extension_settings.mazegame.movementHoldMs);
    $('#mazegame_movement_hold').on('input change', function () {
        extension_settings.mazegame.movementHoldMs = clampNumber($(this).val(), 200, 50, 1000);
        saveSettingsDebounced();
    });
    $('#mazegame_movement_step_delay').val(extension_settings.mazegame.movementStepDelayMs);
    $('#mazegame_movement_step_delay').on('input change', function () {
        extension_settings.mazegame.movementStepDelayMs = clampNumber($(this).val(), 150, 0, 2000);
        saveSettingsDebounced();
    });
    $('#mazegame_movement_max_actions').val(extension_settings.mazegame.movementMaxActionsPerTick);
    $('#mazegame_movement_max_actions').on('input change', function () {
        extension_settings.mazegame.movementMaxActionsPerTick = clampNumber($(this).val(), 4, 1, 12);
        saveSettingsDebounced();
    });
    $('#mazegame_movement_start_delay').val(extension_settings.mazegame.movementStartupDelaySeconds);
    $('#mazegame_movement_start_delay').on('input change', function () {
        extension_settings.mazegame.movementStartupDelaySeconds = clampNumber($(this).val(), 20, 0, 120);
        saveSettingsDebounced();
    });
    $('#mazegame_movement_comment_enabled').prop('checked', extension_settings.mazegame.movementCommentEnabled);
    $('#mazegame_movement_comment_enabled').on('input change', function () {
        extension_settings.mazegame.movementCommentEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mazegame_movement_comment_every').val(extension_settings.mazegame.movementCommentEveryTicks);
    $('#mazegame_movement_comment_every').on('input change', function () {
        extension_settings.mazegame.movementCommentEveryTicks = clampNumber($(this).val(), 4, 1, 20);
        saveSettingsDebounced();
    });
    $('#mazegame_use_comment_prompt').prop('checked', extension_settings.mazegame.movementUseCommentPrompt);
    $('#mazegame_use_comment_prompt').on('input change', function () {
        extension_settings.mazegame.movementUseCommentPrompt = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mazegame_use_caption_prompt').prop('checked', extension_settings.mazegame.movementUseCaptionPrompt);
    $('#mazegame_use_caption_prompt').on('input change', function () {
        extension_settings.mazegame.movementUseCaptionPrompt = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mazegame_movement_fallback').val(extension_settings.mazegame.movementFallbackMode || 'clockwise');
    $('#mazegame_movement_fallback').on('input change', function () {
        const v = String($(this).val());
        extension_settings.mazegame.movementFallbackMode = ['clockwise', 'random'].includes(v) ? v : 'clockwise';
        saveSettingsDebounced();
    });
    $('#mazegame_movement_stop_chat').prop('checked', extension_settings.mazegame.movementStopOnChatChange);
    $('#mazegame_movement_stop_chat').on('input change', function () {
        extension_settings.mazegame.movementStopOnChatChange = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mazegame_movement_stop_pause').prop('checked', extension_settings.mazegame.movementStopWhenPaused);
    $('#mazegame_movement_stop_pause').on('input change', function () {
        extension_settings.mazegame.movementStopWhenPaused = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mazegame_show_last_dir').prop('checked', extension_settings.mazegame.movementShowLastDirection);
    $('#mazegame_show_last_dir').on('input change', function () {
        extension_settings.mazegame.movementShowLastDirection = $(this).prop('checked');
        updateMovementDebugUI();
        saveSettingsDebounced();
    });
    $('#mazegame_show_tick_counter').prop('checked', extension_settings.mazegame.movementShowTickCounter);
    $('#mazegame_show_tick_counter').on('input change', function () {
        extension_settings.mazegame.movementShowTickCounter = $(this).prop('checked');
        updateMovementDebugUI();
        saveSettingsDebounced();
    });
    $('#mazegame_log_decisions').prop('checked', extension_settings.mazegame.movementLogDecisions);
    $('#mazegame_log_decisions').on('input change', function () {
        extension_settings.mazegame.movementLogDecisions = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mazegame_loop_break_enabled').prop('checked', extension_settings.mazegame.movementLoopBreakEnabled !== false);
    $('#mazegame_loop_break_enabled').on('input change', function () {
        extension_settings.mazegame.movementLoopBreakEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mazegame_export_logs_json').on('click', function () {
        void exportMovementLogsJson();
    });
    $('#mazegame_caption_prompt').val(extension_settings.mazegame.captionPrompt);
    $('#mazegame_caption_prompt').on('input change', function () {
        extension_settings.mazegame.captionPrompt = $(this).val();
        saveSettingsDebounced();
    });
    $('#mazegame_comment_prompt').val(extension_settings.mazegame.commentPrompt);
    $('#mazegame_comment_prompt').on('input change', function () {
        extension_settings.mazegame.commentPrompt = $(this).val();
        saveSettingsDebounced();
    });
    $('#mazegame_force_captions').prop('checked', extension_settings.mazegame.forceCaptions);
    $('#mazegame_force_captions').on('input change', function () {
        extension_settings.mazegame.forceCaptions = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#mazegame_shader_scanline').val(extension_settings.mazegame.shaderScanlineStrength ?? defaultSettings.shaderScanlineStrength);
    $('#mazegame_shader_scanline').on('input change', function () {
        extension_settings.mazegame.shaderScanlineStrength = Number($(this).val());
        saveSettingsDebounced();
        sendShaderSettingsToEmulator();
    });

    $('#mazegame_shader_dither').val(extension_settings.mazegame.shaderDitherStrength ?? defaultSettings.shaderDitherStrength);
    $('#mazegame_shader_dither').on('input change', function () {
        extension_settings.mazegame.shaderDitherStrength = Number($(this).val());
        saveSettingsDebounced();
        sendShaderSettingsToEmulator();
    });

    $('#mazegame_shader_color_steps').val(extension_settings.mazegame.shaderColorSteps ?? defaultSettings.shaderColorSteps);
    $('#mazegame_shader_color_steps').on('input change', function () {
        extension_settings.mazegame.shaderColorSteps = Number($(this).val());
        saveSettingsDebounced();
        sendShaderSettingsToEmulator();
    });

    $('#mazegame_shader_vignette').val(extension_settings.mazegame.shaderVignette ?? defaultSettings.shaderVignette);
    $('#mazegame_shader_vignette').on('input change', function () {
        extension_settings.mazegame.shaderVignette = Number($(this).val());
        saveSettingsDebounced();
        sendShaderSettingsToEmulator();
    });

    updateRuntimeModeUI();
    updateMovementDebugUI();
});

function sendShaderSettingsToEmulator() {
    const frameElement = document.getElementById('mazegame_frame');
    if (!frameElement || !frameElement.contentWindow) return;
    try {
        frameElement.contentWindow.postMessage({
            type: 'SHADER_SETTINGS_UPDATE',
            shaderScanlineStrength: extension_settings.mazegame.shaderScanlineStrength ?? defaultSettings.shaderScanlineStrength,
            shaderDitherStrength: extension_settings.mazegame.shaderDitherStrength ?? defaultSettings.shaderDitherStrength,
            shaderColorSteps: extension_settings.mazegame.shaderColorSteps ?? defaultSettings.shaderColorSteps,
            shaderVignette: extension_settings.mazegame.shaderVignette ?? defaultSettings.shaderVignette,
        }, '*');
    } catch {
        // ignore
    }
}
