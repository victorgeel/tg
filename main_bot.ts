import { TelegramClient, Api } from 'npm:telegram';
import { StringSession } from 'npm:telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'npm:telegram/events/index.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, GenerationConfig, Tool, Content } from 'npm:@google/generative-ai';
import "jsr:@std/dotenv@0.225.4/load"; // Auto-loads .env for local dev (Cloud Shell)

// --- Configuration & Environment Variables ---
const API_ID_STR = Deno.env.get("TELEGRAM_API_ID");
const API_HASH = Deno.env.get("TELEGRAM_API_HASH");
const SESSION_STRING = Deno.env.get("TELEGRAM_SESSION_STRING");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const ALLOWED_GROUP_ID_SETTING = Deno.env.get("ALLOWED_GROUP_ID") || "";
const GEMINI_MODEL_NAME_FROM_ENV = Deno.env.get("GEMINI_MODEL_NAME");

// --- Validate Configuration ---
if (!API_ID_STR || !API_HASH || !SESSION_STRING || !GEMINI_API_KEY) {
    console.error("❌ FATAL_CONFIG: Missing critical environment variables: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING, or GEMINI_API_KEY.");
    console.error("Ensure these are set in your .env file or Deno Deploy project settings.");
    throw new Error("CRITICAL_ENV_VAR_MISSING_FOR_BOT");
}
const API_ID = parseInt(API_ID_STR);
if (isNaN(API_ID)) {
    console.error("❌ FATAL_CONFIG: TELEGRAM_API_ID must be a number.");
    throw new Error("INVALID_TELEGRAM_API_ID_FOR_BOT");
}

const GEMINI_MODEL_NAME = GEMINI_MODEL_NAME_FROM_ENV || "gemini-1.5-flash";
console.log(`[CONFIG] ✅ Using Gemini Model: ${GEMINI_MODEL_NAME}`);
console.log(`[CONFIG] ✅ Allowed Group ID Setting: '${ALLOWED_GROUP_ID_SETTING}'`);

// --- Constants (Text-to-Text focused) ---
const MAX_HISTORY_LENGTH = 10;
const GROUNDING_DAILY_QUOTA = 500;
const GROUNDING_TOOL: Tool[] = [{ googleSearch: {} }];
const KV_QUOTA_COUNT_KEY = ["groundingQuotaCount_v_main_bot_final"]; // Updated KV Key
const KV_QUOTA_RESET_DATE_KEY = ["groundingQuotaResetDateMST_v_main_bot_final"]; // Updated KV Key
const CONVERSATION_KV_PREFIX = "personalConv_v_main_bot_final"; // Updated KV Key

const QUOTA_EXCEEDED_MESSAGE = "⚠️ တောင်းပန်ပါတယ်၊ ယနေ့အတွက် အချက်အလက်ရှာဖွေမှု (Grounding) Quota ပြည့်သွားပါပြီ။ သာမန်အဖြေကိုသာ ရရှိပါမည်။";
const GENERIC_ERROR_MESSAGE = "တောင်းပန်ပါတယ်၊ အကြောင်းပြန်ဖို့ အဆင်မပြေဖြစ်နေပါတယ်။";
const KV_ERROR_MESSAGE = "⚠️ Internal error: မှတ်ဉာဏ် သို့မဟုတ် Quota အချက်အလက်ကို ရယူ/သိမ်းဆည်းရာတွင် အမှားဖြစ်ပွားနေပါသည်။";
const SAFETY_BLOCK_MESSAGE = "တောင်းပန်ပါသည်။ ဤအကြောင်းအရာသည် လုံခြုံရေးအရ မသင့်လျော်ပါ။";
const BAD_REQUEST_MESSAGE = "Gemini API Error: မမှန်ကန်သော တောင်းဆိုမှု။";
const RESET_CONFIRMATION_USER = "သင့်မှတ်ဉာဏ်ကို ရှင်းလင်းပြီးပါပြီ။";
const RESET_ERROR = "⚠️ မှတ်ဉာဏ်ရှင်းလင်းရာတွင် အမှား ဖြစ်ပွားပါသည်။";
const MEDIA_UNSUPPORTED_MESSAGE = "ℹ️ စာသား message များကိုသာ လက်ခံပါသည်။";

const GROUNDING_KEYWORDS = [ "ရှာဖွေ", "နောက်ဆုံးရ", "latest", "search for", "ဘယ်လောက်လဲ", "ဘယ်မှာလဲ", "ဘယ်သူလဲ", "ဘယ်အချိန်က", "ဘာဖြစ်", "အကြောင်းပြ", "အတည်ပြု", "update", "ရာသီဥတု", "သတင်း", "ဆိုတာဘာလဲ", "အဓိပ္ပါယ်", "အချက်အလက်", "စာရင်း", "စျေးနှုန်း", "ဘယ်နေရာ", "ဘယ်လိုသွားရ", "ရှင်းပြပါ", "ဖြစ်နိုင်လား", "ရှိလား", "ဖွင့်လား", "ပိတ်လား", "ဘယ်နေ့", "define", "who is", "what is", "where is", "how much", "how many", "confirm", "verify", "news" ];

// --- Initialize Clients and KV Store ---
const stringSessionForBot = new StringSession(SESSION_STRING);
const client = new TelegramClient(stringSessionForBot, API_ID, API_HASH, {
    connectionRetries: 5,
    baseLogger: undefined, // Use default logger
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
    model: GEMINI_MODEL_NAME,
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    ],
});

let kv: Deno.Kv | null = null; // Will be initialized in runBot()
let selfId: BigInt | undefined;

// --- Helper Functions ---
function getCurrentMSTDateString(): string {
    const now = new Date();
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit',
        });
        return formatter.format(now);
    } catch (e) {
        console.warn("[HELPER_DATE] Intl.DateTimeFormat for Asia/Yangon failed.", e);
        const offsetMilliseconds = (6 * 60 + 30) * 60 * 1000;
        const mstTime = new Date(now.getTime() + offsetMilliseconds);
        return mstTime.toISOString().slice(0, 10);
    }
}

async function resetDailyGroundingQuotaInternal(): Promise<void> {
    if (!kv) { console.warn("[QUOTA_HELPER] KV unavailable for quota reset during cron execution."); return; }
    try {
        const currentMSTDate = getCurrentMSTDateString();
        await kv.atomic()
            .set(KV_QUOTA_COUNT_KEY, 0)
            .set(KV_QUOTA_RESET_DATE_KEY, currentMSTDate)
            .commit();
        console.log(`[QUOTA_HELPER] Daily grounding quota reset successfully for MST date: ${currentMSTDate}.`);
    } catch (error) { console.error("[QUOTA_HELPER] Error resetting daily grounding quota:", error); }
}

async function initializeKvStoreForCron() {
    if (!kv) {
        try {
            kv = await Deno.openKv();
            console.log("[INIT_CRON_KV] ✅ Deno KV store opened/verified for cron usage.");
        } catch (error) {
            console.warn("[INIT_CRON_KV] ⚠️ Error opening Deno KV store for cron. Quota reset might fail:", error.message);
        }
    }
}
initializeKvStoreForCron(); // Initialize KV at top-level for Cron

Deno.cron("daily_quota_bot_main_final", "33 17 * * *", async () => { // Unique cron name, slightly different time
    console.log("[CRON_MAIN_BOT] Attempting to execute daily grounding quota reset job...");
    if (!kv) { // Check KV again, attempt to open if it failed earlier
        console.warn("[CRON_MAIN_BOT] KV store not available when cron job triggered. Attempting to open again...");
        await initializeKvStoreForCron(); // Re-attempt KV initialization
        if (!kv) {
            console.error("[CRON_MAIN_BOT] Failed to open KV store from within cron job after re-attempt. Quota reset will fail.");
            return;
        }
    }
    await resetDailyGroundingQuotaInternal();
});
console.log(`[INIT] ✅ Daily grounding quota reset cron for main_bot scheduled.`);


async function getGroundingQuotaStatus(): Promise<{ count: number; isAllowed: boolean; resetDate: string | null }> {
    if (!kv) { console.warn("[QUOTA_HELPER] KV unavailable for quota check."); return { count: 0, isAllowed: false, resetDate: null }; }
    try {
        const currentMSTDate = getCurrentMSTDateString();
        const [countEntry, dateEntry] = await kv.getMany<[number, string]>([KV_QUOTA_COUNT_KEY, KV_QUOTA_RESET_DATE_KEY]);
        const lastResetDate = dateEntry?.value ?? null;
        let currentCount = countEntry?.value ?? 0;

        if (lastResetDate !== currentMSTDate) {
            await resetDailyGroundingQuotaInternal();
            const newCountEntry = await kv.get<number>(KV_QUOTA_COUNT_KEY);
            currentCount = newCountEntry?.value ?? 0;
            return { count: currentCount, isAllowed: currentCount < GROUNDING_DAILY_QUOTA, resetDate: currentMSTDate };
        } else {
            return { count: currentCount, isAllowed: currentCount < GROUNDING_DAILY_QUOTA, resetDate: lastResetDate };
        }
    } catch (error) {
        console.error("[QUOTA_HELPER] Error getting grounding quota status:", error);
        return { count: 0, isAllowed: false, resetDate: null };
    }
}

async function incrementGroundingQuota(): Promise<void> {
    if (!kv) { console.warn("[QUOTA_HELPER] KV unavailable for quota increment."); return; }
    try {
        const countEntry = await kv.get<number>(KV_QUOTA_COUNT_KEY);
        const currentCount = countEntry?.value ?? 0;
        if (currentCount < GROUNDING_DAILY_QUOTA) {
            const result = await kv.atomic()
                .check(countEntry!) // Ensure entry exists for check
                .set(KV_QUOTA_COUNT_KEY, currentCount + 1)
                .commit();
            if (!result.ok) console.warn(`[QUOTA_HELPER] Atomic increment for quota failed.`);
        }
    } catch (error) { console.error("[QUOTA_HELPER] Error incrementing grounding quota:", error); }
}

function isGroundingRequested(prompt: string): boolean {
    if (!prompt) return false;
    const lowerCasePrompt = prompt.toLowerCase();
    return GROUNDING_KEYWORDS.some(keyword => {
        const K = keyword.toLowerCase();
        const regex = new RegExp(`\\b${K.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        return regex.test(lowerCasePrompt) || lowerCasePrompt.includes(K);
    });
}

// --- Gemini API Call Function ---
const GEMINI_GENERATION_CONFIG_BOT: GenerationConfig = { temperature: 0.7 };
const GEMINI_API_URL_BASE_BOT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}`;

interface GeminiHistoryItem {
    role: "user" | "model";
    parts: { text: string }[];
}

async function callGeminiAPIBot(requestBody: {contents: Content[], systemInstruction?: Content, generationConfig?: GenerationConfig, tools?: Tool[]}): Promise<any> {
    const lastUserMessage = requestBody.contents.filter(c => c.role === 'user').slice(-1);
    console.log(`[GEMINI_BOT_API_CALL] Sending request. Last user: ${JSON.stringify(lastUserMessage)}`);
    if (requestBody.tools) console.log(`[GEMINI_BOT_API_CALL] Using tools: ${JSON.stringify(requestBody.tools)}`);

    const response = await fetch(
        `${GEMINI_API_URL_BASE_BOT}:generateContent?key=${GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) }
    );
    const responseBodyText = await response.text();
    if (!response.ok) {
        console.error(`[GEMINI_BOT_API_ERROR] ${response.status}:`, responseBodyText);
        if (response.status === 429) throw new Error("GEMINI_QUOTA_EXCEEDED");
        if (response.status === 400) throw new Error("GEMINI_BAD_REQUEST");
        throw new Error(`GEMINI_API_ERROR_HTTP_${response.status}`);
    }
    try { return JSON.parse(responseBodyText); } catch (e) {
        console.error("[GEMINI_BOT_API_ERROR] Failed to parse Gemini JSON response:", responseBodyText);
        throw new Error("GEMINI_INVALID_JSON_RESPONSE");
    }
}

async function getGeminiTextResponse(chatIdStr: string, userIdStr: string, text: string, originalText: string): Promise<string | null> {
    console.log(`[GET_GEMINI_RESPONSE] Started for User [${userIdStr}], Chat [${chatIdStr}]. Text: "${text.substring(0,50)}..."`);
    if (!kv) { console.warn(`[GET_GEMINI_RESPONSE] KV store unavailable for User [${userIdStr}].`);}
    const kvHistoryKey = [CONVERSATION_KV_PREFIX, chatIdStr, "user", userIdStr];
    let useGroundingTool = false;
    let quotaWarning = "";
    let history: GeminiHistoryItem[] = [];

    if (kv) {
        try {
            const historyEntry = await kv.get<GeminiHistoryItem[]>(kvHistoryKey);
            if (historyEntry?.value) {
                history = historyEntry.value;
                console.log(`[GET_GEMINI_RESPONSE] Loaded ${history.length} history items for User [${userIdStr}].`);
            }
        } catch (kvReadError) { console.error(`[KV_READ_ERROR] Failed to read history for User [${userIdStr}]:`, kvReadError); }
    }

    try {
        if (isGroundingRequested(originalText)) {
            const quotaStatus = await getGroundingQuotaStatus();
            if (quotaStatus.isAllowed) {
                useGroundingTool = true;
                console.log(`[GET_GEMINI_RESPONSE] Grounding Quota available for User [${userIdStr}].`);
            } else {
                quotaWarning = QUOTA_EXCEEDED_MESSAGE + "\n\n";
                console.log(`[GET_GEMINI_RESPONSE] Grounding Quota EXCEEDED for User [${userIdStr}].`);
            }
        }
        const newUserMessage: GeminiHistoryItem = { role: "user", parts: [{ text: text }] };
        const contentsPayload: Content[] = [...history, newUserMessage] as Content[];
        const systemInstructionText = "သင်သည် မြန်မာဘာသာစကားကို အဓိကအသုံးပြုသော AI လက်ထောက်ဖြစ်သည်။ ဖော်ရွေပြီး၊ လူအများနားလည်လွယ်သော မြန်မာစကားကိုသုံးပါ။";
        const systemInstruction: Content = { role: "system", parts: [{ text: systemInstructionText }] };
        const requestBody: {contents: Content[], systemInstruction?: Content, generationConfig?: GenerationConfig, tools?: Tool[]} = {
            contents: contentsPayload,
            generationConfig: GEMINI_GENERATION_CONFIG_BOT,
            systemInstruction: systemInstruction,
        };
        if (useGroundingTool) requestBody.tools = GROUNDING_TOOL;

        const data = await callGeminiAPIBot(requestBody);
        if (useGroundingTool && data.candidates) await incrementGroundingQuota();
        const candidate = data.candidates?.[0];

        if (!candidate) {
            if (data.promptFeedback?.blockReason) {
                console.warn(`[GET_GEMINI_RESPONSE] [SAFETY] Gemini prompt blocked for User [${userIdStr}]. Reason: ${data.promptFeedback.blockReason}`);
                return SAFETY_BLOCK_MESSAGE;
            }
            console.error(`[GET_GEMINI_RESPONSE] [API_ERROR] Gemini API response missing candidates for User [${userIdStr}].`);
            return GENERIC_ERROR_MESSAGE + " (No candidate)";
        }
        if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
            if (candidate.finishReason === "SAFETY") {
                console.warn(`[GET_GEMINI_RESPONSE] [SAFETY] Gemini response flagged for safety for User [${userIdStr}].`);
                return SAFETY_BLOCK_MESSAGE;
            }
        }
        const responseText = candidate.content?.parts?.[0]?.text?.trim() || null;
        console.log(`[GET_GEMINI_RESPONSE] Gemini raw response text (first 100 chars): "${responseText ? responseText.substring(0,100) + '...' : 'null'}"`);

        if (responseText && kv) {
            const newModelMessage: GeminiHistoryItem = { role: "model", parts: [{ text: responseText }] };
            let updatedHistory = [...history, newUserMessage, newModelMessage];
            if (updatedHistory.length > MAX_HISTORY_LENGTH * 2) {
                updatedHistory = updatedHistory.slice(-(MAX_HISTORY_LENGTH * 2));
            }
            try {
                await kv.set(kvHistoryKey, updatedHistory);
                console.log(`[GET_GEMINI_RESPONSE] [KV_WRITE_SUCCESS] History saved for User [${userIdStr}].`);
            } catch (kvWriteError) {
                console.error(`[GET_GEMINI_RESPONSE] [KV_WRITE_ERROR] Failed to save history for User [${userIdStr}]:`, kvWriteError);
            }
        }
        return responseText ? quotaWarning + responseText : (candidate.finishReason === "SAFETY" ? SAFETY_BLOCK_MESSAGE : GENERIC_ERROR_MESSAGE + " (Empty response)");
    } catch (error: any) {
        console.error(`💥 Error in getGeminiTextResponse for User [${userIdStr}]:`, error.message);
        if (error.message === "GEMINI_QUOTA_EXCEEDED") return QUOTA_EXCEEDED_MESSAGE;
        if (error.message === "GEMINI_BAD_REQUEST") return BAD_REQUEST_MESSAGE;
        return `${GENERIC_ERROR_MESSAGE} (Text API Call Error)`;
    }
}

// --- Main Message Processing Function ---
async function processMessage(message: Api.Message, chatId: BigInt, userId: BigInt, messageId: number): Promise<void> {
    console.log(`--- processMessage CALLED for User [${userId}] in Chat [${chatId}], MsgID [${messageId}] ---`);
    let responseText: string | null = null;
    try {
        console.log(`[PROCESS_MESSAGE] Sending typing action to Chat [${chatId}]`);
        await client.sendTyping(chatId);

        if (message.text) {
            const messageText = message.text.trim();
            console.log(`[PROCESS_MESSAGE] Received text: "${messageText.substring(0,70)}..." from User [${userId}]`);
            if (messageText.toLowerCase() === "/reset") {
                console.log(`[PROCESS_MESSAGE] Reset command detected from User [${userId}] for Chat [${chatId}].`);
                if (!kv) {
                    responseText = KV_ERROR_MESSAGE;
                    console.warn(`[PROCESS_MESSAGE] KV store unavailable for reset command.`);
                } else {
                    try {
                        const kvKey = [CONVERSATION_KV_PREFIX, chatId.toString(), "user", userId.toString()];
                        await kv.delete(kvKey);
                        responseText = RESET_CONFIRMATION_USER;
                        console.log(`[PROCESS_MESSAGE] [KV] User [${userId}] history cleared for chat [${chatId}].`);
                    } catch (error) {
                        console.error(`[PROCESS_MESSAGE] [KV] Error clearing history for User [${userId}]:`, error);
                        responseText = RESET_ERROR;
                    }
                }
            } else {
                 console.log(`[PROCESS_MESSAGE] Calling getGeminiTextResponse for User [${userId}], Text: "${messageText.substring(0,70)}..."`);
                 responseText = await getGeminiTextResponse(chatId.toString(), userId.toString(), messageText, messageText);
            }
        }
        else if (message.media && !(message.document && message.document.mimeType === "application/geo-uri")) { // Ignore live location which is also media
            console.log(`[PROCESS_MESSAGE] Received non-text media (type: ${message.media?.className || 'unknown media'}) from User [${userId}]. Replying with MEDIA_UNSUPPORTED_MESSAGE.`);
            responseText = MEDIA_UNSUPPORTED_MESSAGE;
        } else {
            console.log(`[PROCESS_MESSAGE] Message from User [${userId}] is not text and not recognized media. No action taken for message ID ${messageId}.`);
        }

        if (responseText) {
            console.log(`[PROCESS_MESSAGE] Attempting to send reply to Chat [${chatId}], User [${userId}]: "${responseText.substring(0,100)}..."`);
            await client.sendMessage(chatId, { message: responseText, replyTo: messageId });
            console.log(`[PROCESS_MESSAGE] Reply sent successfully to Chat [${chatId}], User [${userId}].`);
        } else {
            // Only log if it was a text message that should have produced a response but didn't
            if (message.text && message.text.toLowerCase() !== "/reset") { // Don't log "no response" for /reset if it was handled
                console.log(`[PROCESS_MESSAGE] No responseText generated for text message ID ${messageId} from User [${userId}] (Chat ${chatId}). Not sending reply.`);
            } else if (!message.text && !message.media) { // Truly empty message
                 console.log(`[PROCESS_MESSAGE] Received an empty or unhandled message type (ID: ${messageId}). No action taken.`);
            }
        }
    } catch (error: any) {
        console.error(`💥 Error in processMessage for User [${userId}] (Chat [${chatId}]):`, error.message || error);
        try {
            const errorReply = `${GENERIC_ERROR_MESSAGE} (Detail: ${error.message || 'Unknown error in processMessage'})`;
            console.log(`[PROCESS_MESSAGE] Attempting to send error reply to Chat [${chatId}]: "${errorReply}"`);
            await client.sendMessage(chatId, { message: errorReply, replyTo: messageId });
        } catch (sendError) {
            console.error(`[PROCESS_MESSAGE] Failed to send error message to chat ${chatId}:`, sendError);
        }
    }
}

// --- GramJS Event Handler ---
async function handleNewMessage(event: NewMessageEvent): Promise<void> {
    console.log("--- handleNewMessage CALLED: New event received ---");
    const message = event.message;
    if (!message || !message.chatId || !message.senderId || !message.id) {
        console.warn("[HANDLE_NEW_MESSAGE] Ignoring event: Message or critical fields (chatId, senderId, id) are missing.");
        return;
    }
    const chatId = message.chatId;
    const senderId = message.senderId;
    const messageId = message.id;

    console.log(`[HANDLE_NEW_MESSAGE] Incoming message from senderId: ${senderId}, chatId: ${chatId}, messageId: ${messageId}, text (first 50 chars): "${message.text ? message.text.substring(0,50) + '...' : (message.media ? `[Media: ${message.media.className}]` : '[No text/media]')}"`);

    if (!selfId) {
        console.warn("[HANDLE_NEW_MESSAGE] selfId not initialized yet. Ignoring message. This indicates an issue in the runBot startup sequence.");
        return;
    }
    if (senderId.toString() === selfId.toString()) {
        // console.log("[HANDLE_NEW_MESSAGE] Ignoring own message."); // Usually not needed unless debugging self-interaction
        return;
    }

    const chatType = event.isPrivate ? "private" : (event.isGroup ? "group" : (event.isChannel ? "channel" : "unknown"));
    let shouldProcess = false;

    console.log(`[HANDLE_NEW_MESSAGE] [Filter] Chat Type: ${chatType}, ALLOWED_GROUP_ID_SETTING: '${ALLOWED_GROUP_ID_SETTING}'`);

    if (chatType === "private") {
        shouldProcess = true;
        console.log(`[HANDLE_NEW_MESSAGE] [Filter] Determined: Should process (Private Chat).`);
    } else if (chatType === "group" || chatType === "channel") { // Treat channels like groups for listening
        if (ALLOWED_GROUP_ID_SETTING.toUpperCase() === "ALL") {
            shouldProcess = true;
            console.warn(`[HANDLE_NEW_MESSAGE] [Filter] Determined: Should process (Group/Channel matches 'ALL' setting).`);
        } else if (ALLOWED_GROUP_ID_SETTING && chatId.toString() === ALLOWED_GROUP_ID_SETTING) {
            shouldProcess = true;
            console.log(`[HANDLE_NEW_MESSAGE] [Filter] Determined: Should process (Group/Channel ID matches ALLOWED_GROUP_ID_SETTING).`);
        } else if (!ALLOWED_GROUP_ID_SETTING) {
            console.log(`[HANDLE_NEW_MESSAGE] [Filter] Determined: Should NOT process Group/Channel (ALLOWED_GROUP_ID_SETTING is empty, DM only).`);
        } else {
            console.log(`[HANDLE_NEW_MESSAGE] [Filter] Determined: Should NOT process Group/Channel [${chatId}] (ID does not match ALLOWED_GROUP_ID_SETTING: '${ALLOWED_GROUP_ID_SETTING}').`);
        }
    } else {
         console.log(`[HANDLE_NEW_MESSAGE] [Filter] Determined: Should NOT process (Unhandled chat type: ${chatType}) in Chat [${chatId}].`);
    }

    if (shouldProcess) {
        if (message.text || (message.media && !(message.document && message.document.mimeType === "application/geo-uri"))) { // Ensure there's text or processable media
            console.log(`[HANDLE_NEW_MESSAGE] [Router] Routing to processMessage for User [${senderId}] in Chat [${chatId}]`);
            await processMessage(message, chatId, senderId, messageId);
        } else {
            console.log(`[HANDLE_NEW_MESSAGE] [Router] Message from User [${senderId}] in Chat [${chatId}] has no text or is an unhandled media type (like live location). Ignoring.`);
        }
    } else {
        // console.log(`[HANDLE_NEW_MESSAGE] [FinalDecision] Message from User [${senderId}] in Chat [${chatId}] will NOT be processed based on filter logic.`); // Can be too noisy
    }
}

// --- Start the Client ---
async function runBot() {
    console.log("🚀 Initializing Deno Personal Account Bot (Text-Only, 'telegram' package, JSR dotenv)...");

    // Initialize KV store here if not already done by cron's IIFE, ensuring it's available for the main app logic
    if (!kv) {
        try {
            kv = await Deno.openKv();
            console.log("[RUN_BOT] ✅ Deno KV store opened successfully from runBot.");
        } catch (error) {
            console.warn("[RUN_BOT] ⚠️ Error opening Deno KV store from runBot. History and quota features might be affected:", error.message);
            // Allow to continue without KV, features will be degraded.
        }
    }

    try {
        console.log("[RUN_BOT] Attempting to connect Telegram client with session string from environment variable...");
        if (!client.connected) { // Connect only if not already connected (e.g. if runBot is called multiple times, though it shouldn't be)
            await client.connect();
        }
        console.log("[RUN_BOT] ✅ Telegram client connected (or was already connected).");

        const me = await client.getMe(); // me can be boolean false if not authorized
        if (me && typeof me === 'object' && 'id' in me && me.id && (typeof me.id === 'bigint' || typeof me.id === 'number')) {
             selfId = (typeof me.id === 'bigint') ? me.id : BigInt(me.id); // Ensure selfId is BigInt
             let username = 'N/A';
             if ('username' in me && typeof me.username === 'string' && me.username) username = me.username;
             let firstName = '';
             if ('firstName'in me && typeof me.firstName === 'string' && me.firstName) firstName = me.firstName;
             let lastName = '';
             if ('lastName' in me && typeof me.lastName === 'string' && me.lastName) lastName = me.lastName;
             console.log(`[RUN_BOT] ✅ Logged in as: ${firstName || ''} ${lastName || ''} (@${username}) - ID: ${selfId}`);
        } else {
            console.error("[RUN_BOT] ❌ CRITICAL: Could not get own user details or ID. The TELEGRAM_SESSION_STRING might be invalid or expired.");
            console.error("Please regenerate the TELEGRAM_SESSION_STRING and update it in Deno Deploy environment variables.");
            throw new Error("FAILED_TO_GET_SELF_ID_SESSION_INVALID_AT_STARTUP"); // More specific error
        }

        client.addEventHandler(handleNewMessage, new NewMessage({}));
        console.log("[RUN_BOT] 👂 Listening for new messages...");
        // Deno Deploy keeps the process alive due to active listeners/intervals.

    } catch (error) {
        console.error("💥 FATAL_RUN_BOT: Failed to connect or run client with session string:", error.message || error);
        // Common session-related errors
        if (error.message?.includes("SESSION_PASSWORD_NEEDED")) {
            console.error("🔒 Error Hint: 2FA Password might be required by session. Session string may be invalid/expired. Regenerate session.");
        } else if (error.message?.includes("Auth key must be generated") || error.message?.includes("AUTH_KEY_UNREGISTERED") || error.message?.includes("SESSION_REVOKED")) {
            console.error("🔑 Error Hint: Session string invalid/corrupted/revoked/expired. Regenerate TELEGRAM_SESSION_STRING.");
        } else if (error.message?.includes("PHONE_CODE_INVALID")) {
             console.error("📞 Error Hint: Phone code (from previous session generation) was invalid. Regenerate session.");
        }
        console.error("🛑 Ensure TELEGRAM_SESSION_STRING is correctly set and valid.");
        throw error; // Re-throw the error to ensure Deno Deploy marks deployment as failed
    }
}

// Run the main bot function
runBot().catch(finalError => {
    console.error("💥 UNHANDLED_ERROR_IN_RUN_BOT_FUNCTION:", finalError.message || finalError);
    // In Deno Deploy, an unhandled promise rejection will cause the deployment to be marked as errored.
    // No need for Deno.exit(1) here.
});

