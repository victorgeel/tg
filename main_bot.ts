import { TelegramClient, Api } from 'npm:telegram';
import { StringSession } from 'npm:telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'npm:telegram/events/index.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, GenerationConfig, Tool, Content } from 'npm:@google/generative-ai';
import "jsr:@std/dotenv/load"; // Auto-loads .env for local dev (Cloud Shell)

// --- Configuration & Environment Variables ---
const API_ID_STR = Deno.env.get("TELEGRAM_API_ID");
const API_HASH = Deno.env.get("TELEGRAM_API_HASH");
const SESSION_STRING = Deno.env.get("TELEGRAM_SESSION_STRING"); // CRITICAL for this bot script
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const ALLOWED_GROUP_ID_SETTING = Deno.env.get("ALLOWED_GROUP_ID") || "";
const GEMINI_MODEL_NAME_FROM_ENV = Deno.env.get("GEMINI_MODEL_NAME");

// --- Validate Configuration ---
if (!API_ID_STR || !API_HASH || !SESSION_STRING || !GEMINI_API_KEY) {
    console.error("❌ FATAL_CONFIG: Missing critical environment variables: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING, or GEMINI_API_KEY.");
    console.error("Ensure these are set in your .env file or Deno Deploy project settings.");
    // Deno.exit(1); // Cannot use in Deno Deploy, throw error instead for startup fail
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
const KV_QUOTA_COUNT_KEY = ["groundingQuotaCount_v_main_bot"]; // Unique keys for this bot
const KV_QUOTA_RESET_DATE_KEY = ["groundingQuotaResetDateMST_v_main_bot"];
const CONVERSATION_KV_PREFIX = "personalConv_v_main_bot";

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
const stringSessionForBot = new StringSession(SESSION_STRING); // Use the session string from .env
const client = new TelegramClient(stringSessionForBot, API_ID, API_HASH, {
    connectionRetries: 5,
    baseLogger: undefined,
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

let kv: Deno.Kv | null = null;
let selfId: BigInt | undefined;

// --- Helper Functions (Copied from previous full bot script) ---
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
    if (!kv) { console.warn("[QUOTA_HELPER] KV unavailable for quota reset during cron."); return; }
    try {
        const currentMSTDate = getCurrentMSTDateString();
        await kv.atomic()
            .set(KV_QUOTA_COUNT_KEY, 0)
            .set(KV_QUOTA_RESET_DATE_KEY, currentMSTDate)
            .commit();
        console.log(`[QUOTA_HELPER] Daily grounding quota reset for MST date: ${currentMSTDate}.`);
    } catch (error) { console.error("[QUOTA_HELPER] Error resetting daily grounding quota:", error); }
}
 // --- Deno Cron Job for Quota Reset (MUST BE AT TOP-LEVEL) ---
 // IIFE for KV init is removed, KV will be initialized in run() before cron uses it.
 // Or, cron callback must handle potential null KV.
 // For Cloud Shell testing, cron might not run correctly if the main script is short-lived.
 // For Deno Deploy, this is fine.

 Deno.cron("daily_quota_bot_main", "32 17 * * *", async () => { // Slightly different time/name
     console.log("[CRON_MAIN_BOT] Attempting to execute daily grounding quota reset job...");
     if (!kv) {
         console.warn("[CRON_MAIN_BOT] KV store not available when cron job triggered. Attempting to open...");
         try {
             kv = await Deno.openKv();
             console.log("[CRON_MAIN_BOT] KV store opened from within cron job.");
         } catch (e) {
             console.error("[CRON_MAIN_BOT] Failed to open KV store from within cron job. Quota reset will likely fail.", e);
             return;
         }
     }
     await resetDailyGroundingQuotaInternal();
 });
 console.log(`[INIT] ✅ Daily grounding quota reset cron for main_bot scheduled for 00:02 MMT.`);


async function getGroundingQuotaStatus(): Promise<{ count: number; isAllowed: boolean; resetDate: string | null }> {
    if (!kv) { console.warn("[QUOTA_HELPER] KV unavailable for quota check."); return { count: 0, isAllowed: false, resetDate: null }; }
    // ... (rest of getGroundingQuotaStatus from previous full script)
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
    // ... (rest of incrementGroundingQuota from previous full script)
     try {
         const countEntry = await kv.get<number>(KV_QUOTA_COUNT_KEY);
         const currentCount = countEntry?.value ?? 0;
         if (currentCount < GROUNDING_DAILY_QUOTA) {
             const result = await kv.atomic()
                 .check(countEntry!)
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
// (getGeminiTextResponse and callGeminiAPI functions from previous full script)
// ... (Ensure these are copied correctly here) ...
 const GEMINI_GENERATION_CONFIG_BOT: GenerationConfig = { temperature: 0.7 };
 const GEMINI_API_URL_BASE_BOT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}`;

 async function callGeminiAPIBot(requestBody: {contents: Content[], systemInstruction?: Content, generationConfig?: GenerationConfig, tools?: Tool[]}): Promise<any> {
     const lastUserMessage = requestBody.contents.filter(c => c.role === 'user').slice(-1);
     console.log(`[GEMINI_BOT_API_CALL] Sending request. Last user: ${JSON.stringify(lastUserMessage)}`);
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
     try { return JSON.parse(responseBodyText); } catch (e) { throw new Error("GEMINI_INVALID_JSON_RESPONSE"); }
 }

 async function getGeminiTextResponse(chatIdStr: string, userIdStr: string, text: string, originalText: string): Promise<string | null> {
     if (!kv) { console.warn(`[GET_GEMINI_BOT_RESPONSE] KV unavailable for User [${userIdStr}].`);}
     const kvHistoryKey = [CONVERSATION_KV_PREFIX, chatIdStr, "user", userIdStr];
     let useGroundingTool = false;
     let quotaWarning = "";
     let history: GeminiHistoryItem[] = [];

     if (kv) {
         try {
             const historyEntry = await kv.get<GeminiHistoryItem[]>(kvHistoryKey);
             if (historyEntry?.value) history = historyEntry.value;
         } catch (kvReadError) { console.error(`[KV_READ_ERROR] Failed to read history:`, kvReadError); }
     }

     try {
         if (isGroundingRequested(originalText)) {
             const quotaStatus = await getGroundingQuotaStatus();
             if (quotaStatus.isAllowed) useGroundingTool = true;
             else quotaWarning = QUOTA_EXCEEDED_MESSAGE + "\n\n";
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
             if (data.promptFeedback?.blockReason) return SAFETY_BLOCK_MESSAGE;
             return GENERIC_ERROR_MESSAGE + " (No candidate)";
         }
         if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
             if (candidate.finishReason === "SAFETY") return SAFETY_BLOCK_MESSAGE;
         }
         const responseText = candidate.content?.parts?.[0]?.text?.trim() || null;
         if (responseText && kv) {
             const newModelMessage: GeminiHistoryItem = { role: "model", parts: [{ text: responseText }] };
             let updatedHistory = [...history, newUserMessage, newModelMessage];
             if (updatedHistory.length > MAX_HISTORY_LENGTH * 2) {
                 updatedHistory = updatedHistory.slice(-(MAX_HISTORY_LENGTH * 2));
             }
             try { await kv.set(kvHistoryKey, updatedHistory); }
             catch (kvWriteError) { console.error(`[KV_WRITE_ERROR] Failed to save history:`, kvWriteError); }
         }
         return responseText ? quotaWarning + responseText : (candidate.finishReason === "SAFETY" ? SAFETY_BLOCK_MESSAGE : GENERIC_ERROR_MESSAGE + " (Empty resp)");
     } catch (error: any) {
         console.error(`💥 Error in getGeminiTextResponse:`, error.message);
         if (error.message === "GEMINI_QUOTA_EXCEEDED") return QUOTA_EXCEEDED_MESSAGE;
         if (error.message === "GEMINI_BAD_REQUEST") return BAD_REQUEST_MESSAGE;
         return `${GENERIC_ERROR_MESSAGE} (Text API Call Error)`;
     }
 }


// --- Main Message Processing Function ---
// (processMessage function from previous full bot script)
// ... (Ensure this is copied correctly here) ...
 async function processMessage(message: Api.Message, chatId: BigInt, userId: BigInt, messageId: number): Promise<void> {
     console.log(`--- processMessage CALLED for User [${userId}] in Chat [${chatId}], MsgID [${messageId}] ---`);
     let responseText: string | null = null;
     try {
         await client.sendTyping(chatId);
         if (message.text) {
             const messageText = message.text.trim();
             if (messageText.toLowerCase() === "/reset") {
                 if (!kv) { responseText = KV_ERROR_MESSAGE; }
                 else {
                     try {
                         const kvKey = [CONVERSATION_KV_PREFIX, chatId.toString(), "user", userId.toString()];
                         await kv.delete(kvKey);
                         responseText = RESET_CONFIRMATION_USER;
                     } catch (error) { responseText = RESET_ERROR; }
                 }
             } else {
                  responseText = await getGeminiTextResponse(chatId.toString(), userId.toString(), messageText, messageText);
             }
         }
         else if (message.media && !(message.document && message.document.mimeType === "application/geo-uri")) {
             responseText = MEDIA_UNSUPPORTED_MESSAGE;
         }
         if (responseText) {
             await client.sendMessage(chatId, { message: responseText, replyTo: messageId });
         }
     } catch (error: any) {
         console.error(`💥 Error in processMessage for User [${userId}] :`, error.message || error);
         try { await client.sendMessage(chatId, { message: `${GENERIC_ERROR_MESSAGE} (Handler Error)`, replyTo: messageId }); }
         catch (sendError) { console.error(`Failed to send error msg to chat ${chatId}:`, sendError); }
     }
 }


// --- GramJS Event Handler ---
// (handleNewMessage function from previous full bot script)
// ... (Ensure this is copied correctly here) ...
 async function handleNewMessage(event: NewMessageEvent): Promise<void> {
     const message = event.message;
     if (!message || !message.chatId || !message.senderId || !message.id) return;
     const chatId = message.chatId;
     const senderId = message.senderId;
     const messageId = message.id;

     if (!selfId || senderId.toString() === selfId.toString()) return;

     const chatType = event.isPrivate ? "private" : (event.isGroup ? "group" : "unknown");
     let shouldProcess = false;

     if (chatType === "private") {
         shouldProcess = true;
     } else if (chatType === "group") {
         if (ALLOWED_GROUP_ID_SETTING.toUpperCase() === "ALL") shouldProcess = true;
         else if (ALLOWED_GROUP_ID_SETTING && chatId.toString() === ALLOWED_GROUP_ID_SETTING) shouldProcess = true;
     }

     if (shouldProcess && (message.text || message.media)) {
         console.log(`[Router] Routing message from User [${senderId}] in Chat [${chatId}] (Type: ${chatType})`);
         await processMessage(message, chatId, senderId, messageId);
     }
 }

// --- Start the Client ---
async function runBot() { // Renamed from run() to avoid conflict if any global run exists
    console.log("🚀 Initializing Main Bot Client (Text-Only)...");

    if (!kv) { // Initialize KV if cron's IIFE didn't or if it's null
        try {
            kv = await Deno.openKv();
            console.log("[RUN_BOT] ✅ Deno KV store opened successfully.");
        } catch (error) {
            console.warn("[RUN_BOT] ⚠️ Error opening Deno KV store. History/quota features will be affected:", error.message);
        }
    }

    try {
        console.log("[RUN_BOT] Attempting to connect with session string from environment variable...");
        if (!client.connected) { // Connect only if not already connected
             await client.connect();
        }
        console.log("[RUN_BOT] ✅ Telegram client connected (or was already connected).");

        const me = await client.getMe();
        if (me && typeof me === 'object' && 'id' in me && me.id && (typeof me.id === 'bigint' || typeof me.id === 'number')) {
             selfId = (typeof me.id === 'bigint') ? me.id : BigInt(me.id);
             let username = 'N/A';
             if ('username' in me && typeof me.username === 'string' && me.username) username = me.username;
             let firstName = '';
             if ('firstName'in me && typeof me.firstName === 'string' && me.firstName) firstName = me.firstName;
             let lastName = '';
             if ('lastName' in me && typeof me.lastName === 'string' && me.lastName) lastName = me.lastName;
             console.log(`[RUN_BOT] ✅ Logged in as: ${firstName || ''} ${lastName || ''} (@${username}) - ID: ${selfId}`);
        } else {
            console.error("[RUN_BOT] ❌ CRITICAL: Could not get own user details or ID. TELEGRAM_SESSION_STRING might be invalid/expired.");
            throw new Error("FAILED_TO_GET_SELF_ID_FOR_BOT");
        }

        client.addEventHandler(handleNewMessage, new NewMessage({}));
        console.log("[RUN_BOT] 👂 Listening for new messages...");

    } catch (error) {
        console.error("💥 FATAL_RUN_BOT: Failed to connect or run client with session string:", error.message || error);
        // Log specific session errors
        if (error.message?.includes("SESSION_PASSWORD_NEEDED") ||
            error.message?.includes("Auth key must be generated") ||
            error.message?.includes("AUTH_KEY_UNREGISTERED") ||
            error.message?.includes("SESSION_REVOKED") ||
            error.message?.includes("PHONE_CODE_INVALID")) {
            console.error("🔑 Error Hint: Session-related issue. Please regener
