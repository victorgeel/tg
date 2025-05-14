// deno.ts -- combines main_bot.ts and generate_session.ts

import { TelegramClient, Api } from "npm:telegram";
import { StringSession } from "npm:telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "npm:telegram/events/index.js";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, GenerationConfig, Tool, Content } from "npm:@google/generative-ai";
import "jsr:@std/dotenv@0.225.4/load";

// --- Configuration ---
const API_ID_STR = Deno.env.get("TELEGRAM_API_ID");
const API_HASH = Deno.env.get("TELEGRAM_API_HASH");
const SESSION_STRING = (Deno.env.get("TELEGRAM_SESSION_STRING") || "").trim();
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const ALLOWED_GROUP_ID_SETTING = Deno.env.get("ALLOWED_GROUP_ID") || "";
const GEMINI_MODEL_NAME = Deno.env.get("GEMINI_MODEL_NAME") || "gemini-1.5-flash";

// --- For session generation (if needed) ---
async function generateSession() {
  console.log("--- Telegram Session String Generation ---");
  if (!API_ID_STR || !API_HASH) {
    console.error("❌ TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in the .env file.");
    Deno.exit(1);
  }
  const apiId = parseInt(API_ID_STR);
  if (isNaN(apiId)) {
    console.error("❌ TELEGRAM_API_ID must be a number.");
    Deno.exit(1);
  }
  const stringSession = new StringSession(""); // Empty for new session
  const client = new TelegramClient(stringSession, apiId, API_HASH, { connectionRetries: 5 });
  try {
    await client.start({
      phoneNumber: async () => {
        const number = prompt("📞 Enter your phone number (e.g. +959...):");
        if (!number || number.trim() === "") throw new Error("Phone number cannot be empty.");
        return number.trim();
      },
      password: async () => prompt("🔑 Enter your Telegram password (2FA, press Enter if none):") || "",
      phoneCode: async () => {
        const code = prompt("💬 Enter the code you received via Telegram:");
        if (!code || code.trim() === "") throw new Error("Phone code cannot be empty.");
        return code.trim();
      },
      onError: (err: Error) => {
        console.error("Login Error during client.start:", err.message || err);
        if ((err as any).errorMessage === "SESSION_PASSWORD_NEEDED") {
          console.error("Hint: A 2FA password is required for this account.");
        }
        if (err.stack) console.error("Error stack:", err.stack);
      },
    });
    const generatedSession = client.session.save();
    console.log("\n✅ New login successful!");
    console.log("🔒 NEW TELEGRAM_SESSION_STRING (Copy this string):");
    console.log("===================================================================");
    console.log(generatedSession);
    console.log("===================================================================");
    console.log("🛑 Update your .env file with this new session string.");
  } catch (error: any) {
    console.error("💥 Failed to get session string:", error.message || error);
  } finally {
    if (client.connected) await client.disconnect();
    console.log("--- Session generation finished ---");
    Deno.exit(0);
  }
}

// --- If no session string, generate and exit ---
if (!SESSION_STRING) {
  await generateSession();
  // Will exit after generation.
}

// --- Validate bot config before running ---
if (!API_ID_STR || !API_HASH || !SESSION_STRING || !GEMINI_API_KEY) {
  console.error("❌ FATAL_CONFIG: Missing critical environment variables: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING, or GEMINI_API_KEY.");
  throw new Error("CRITICAL_ENV_VAR_MISSING_FOR_BOT");
}
const API_ID = parseInt(API_ID_STR);
if (isNaN(API_ID)) {
  console.error("❌ FATAL_CONFIG: TELEGRAM_API_ID must be a number.");
  throw new Error("INVALID_TELEGRAM_API_ID_FOR_BOT");
}
console.log(`[CONFIG] Session string length: ${SESSION_STRING.length}`);
console.log(`[CONFIG] ✅ Using Gemini Model: ${GEMINI_MODEL_NAME}`);
console.log(`[CONFIG] ✅ Allowed Group ID Setting: '${ALLOWED_GROUP_ID_SETTING}'`);

// --- Constants (copied from main_bot.ts) ---
const MAX_HISTORY_LENGTH = 10;
const GROUNDING_DAILY_QUOTA = 500;
const GROUNDING_TOOL: Tool[] = [{ googleSearch: {} }];
const KV_QUOTA_COUNT_KEY = ["groundingQuotaCount_v_main_bot_final"];
const KV_QUOTA_RESET_DATE_KEY = ["groundingQuotaResetDateMST_v_main_bot_final"];
const CONVERSATION_KV_PREFIX = "personalConv_v_main_bot_final";

const QUOTA_EXCEEDED_MESSAGE = "⚠️ တောင်းပန်ပါတယ်၊ ယနေ့အတွက် အချက်အလက်ရှာဖွေမှု (Grounding) Quota ပြည့်သွားပါပြီ။ မနက်ဖြန်နောက်ထပ်ရှာဖွေမှုများ ပြန်လည်အသုံးပြုနိုင်ပါလိမ့်မည်။";
const GENERIC_ERROR_MESSAGE = "တောင်းပန်ပါတယ်၊ အကြောင်းပြန်ဖို့ အဆင်မပြေဖြစ်နေပါတယ်။";
const KV_ERROR_MESSAGE = "⚠️ Internal error: မှတ်ဉာဏ် သို့မဟုတ် Quota အချက်အလက်ကို ရယူ/သိမ်းဆည်းရာတွင် ပြဿနာတစ်ခု ဖြစ်ပေါ်နေသည်။";
const SAFETY_BLOCK_MESSAGE = "တောင်းပန်ပါသည်။ ဤအကြောင်းအရာသည် လုံခြုံရေးအရ မသင့်လျော်ပါဟု Gemini မှတားမြစ်ထားပါသည်။";
const BAD_REQUEST_MESSAGE = "Gemini API Error: မမှန်ကန်သော တောင်းဆိုမှု။";
const RESET_CONFIRMATION_USER = "သင့်မှတ်ဉာဏ်ကို ရှင်းလင်းပြီးပါပြီ။";
const RESET_ERROR = "⚠️ မှတ်ဉာဏ်ရှင်းလင်းရာတွင် အမှား ဖြစ်ပွားပါသည်။";
const MEDIA_UNSUPPORTED_MESSAGE = "ℹ️ စာသား message များကိုသာ လက်ခံပါသည်။";

const GROUNDING_KEYWORDS = [
  "ရှာဖွေ", "နောက်ဆုံးရ", "latest", "search for", "ဘယ်လောက်လဲ", "ဘယ်မှာလဲ", "ဘယ်သူလဲ", "ဘယ်အချိန်လဲ",
  "အတည်ပြု", "update", "ရာသီဥတု", "သတင်း", "ဆိုတာဘာလဲ", "အဓိပ္ပါယ်", "အချက်အလက်", "စာရင်း",
  "ဘယ်လိုသွားရ", "ရှင်းပြပါ", "ဖြစ်နိုင်လား", "ရှိလား", "ဖွင့်လား", "ပိတ်လား", "ဘယ်လို", "where is", "how much", "how many", "confirm", "verify", "news"
];

// --- Initialize Clients ---
const stringSessionForBot = new StringSession(SESSION_STRING);
const client = new TelegramClient(stringSessionForBot, API_ID, API_HASH, { connectionRetries: 5 });
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
let selfId: bigint | undefined;

// --- Helper Functions ---
function getCurrentMSTDateString(): string {
  const now = new Date();
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return formatter.format(now);
  } catch {
    const offsetMilliseconds = (6 * 60 + 30) * 60 * 1000;
    const mstTime = new Date(now.getTime() + offsetMilliseconds);
    return mstTime.toISOString().slice(0, 10);
  }
}

async function resetDailyGroundingQuotaInternal(): Promise<void> {
  if (!kv) return;
  try {
    const currentMSTDate = getCurrentMSTDateString();
    await kv.atomic()
      .set(KV_QUOTA_COUNT_KEY, 0)
      .set(KV_QUOTA_RESET_DATE_KEY, currentMSTDate)
      .commit();
  } catch (error) { console.error("[QUOTA_HELPER] Error resetting daily grounding quota:", error); }
}

async function initializeKvStoreForCron() {
  if (!kv) {
    try {
      kv = await Deno.openKv();
    } catch (error) {
      console.warn("[INIT_CRON_KV] ⚠️ Error opening Deno KV store for cron:", error.message);
    }
  }
}
initializeKvStoreForCron();

Deno.cron("daily_quota_bot_main_final", "33 17 * * *", async () => {
  if (!kv) await initializeKvStoreForCron();
  if (kv) await resetDailyGroundingQuotaInternal();
});

async function getGroundingQuotaStatus(): Promise<{ count: number; isAllowed: boolean; resetDate: string | null }> {
  if (!kv) return { count: 0, isAllowed: false, resetDate: null };
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
    return { count: 0, isAllowed: false, resetDate: null };
  }
}

async function incrementGroundingQuota(): Promise<void> {
  if (!kv) return;
  try {
    const countEntry = await kv.get<number>(KV_QUOTA_COUNT_KEY);
    const currentCount = countEntry?.value ?? 0;
    if (currentCount < GROUNDING_DAILY_QUOTA) {
      await kv.atomic()
        .check(countEntry!)
        .set(KV_QUOTA_COUNT_KEY, currentCount + 1)
        .commit();
    }
  } catch (error) { }
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

// --- Gemini API Call ---
const GEMINI_GENERATION_CONFIG_BOT: GenerationConfig = { temperature: 0.7 };
const GEMINI_API_URL_BASE_BOT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}`;
interface GeminiHistoryItem { role: "user" | "model"; parts: { text: string }[]; }

async function callGeminiAPIBot(requestBody: {contents: Content[], systemInstruction?: Content, generationConfig?: GenerationConfig, tools?: Tool[]}): Promise<any> {
  const response = await fetch(
    `${GEMINI_API_URL_BASE_BOT}:generateContent?key=${GEMINI_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) }
  );
  const responseBodyText = await response.text();
  if (!response.ok) {
    if (response.status === 429) throw new Error("GEMINI_QUOTA_EXCEEDED");
    if (response.status === 400) throw new Error("GEMINI_BAD_REQUEST");
    throw new Error(`GEMINI_API_ERROR_HTTP_${response.status}`);
  }
  try { return JSON.parse(responseBodyText); }
  catch { throw new Error("GEMINI_INVALID_JSON_RESPONSE"); }
}

async function getGeminiTextResponse(chatIdStr: string, userIdStr: string, text: string, originalText: string): Promise<string | null> {
  const kvHistoryKey = [CONVERSATION_KV_PREFIX, chatIdStr, "user", userIdStr];
  let useGroundingTool = false;
  let quotaWarning = "";
  let history: GeminiHistoryItem[] = [];
  if (kv) {
    try {
      const historyEntry = await kv.get<GeminiHistoryItem[]>(kvHistoryKey);
      if (historyEntry?.value) history = historyEntry.value;
    } catch { }
  }
  try {
    if (isGroundingRequested(originalText)) {
      const quotaStatus = await getGroundingQuotaStatus();
      if (quotaStatus.isAllowed) useGroundingTool = true;
      else quotaWarning = QUOTA_EXCEEDED_MESSAGE + "\n\n";
    }
    const newUserMessage: GeminiHistoryItem = { role: "user", parts: [{ text }] };
    const contentsPayload: Content[] = [...history, newUserMessage] as Content[];
    const systemInstruction: Content = { role: "system", parts: [{ text: "သင်သည် မြန်မာဘာသာစကားကို အဓိကအသုံးပြုသော AI ဖြစ်သည်။" }] };
    const requestBody = {
      contents: contentsPayload,
      generationConfig: GEMINI_GENERATION_CONFIG_BOT,
      systemInstruction,
      ...(useGroundingTool ? { tools: GROUNDING_TOOL } : {})
    };

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
      if (updatedHistory.length > MAX_HISTORY_LENGTH * 2) updatedHistory = updatedHistory.slice(-(MAX_HISTORY_LENGTH * 2));
      try { await kv.set(kvHistoryKey, updatedHistory); } catch { }
    }
    return responseText ? quotaWarning + responseText : (candidate.finishReason === "SAFETY" ? SAFETY_BLOCK_MESSAGE : GENERIC_ERROR_MESSAGE + " (Empty response)");
  } catch (error: any) {
    if (error.message === "GEMINI_QUOTA_EXCEEDED") return QUOTA_EXCEEDED_MESSAGE;
    if (error.message === "GEMINI_BAD_REQUEST") return BAD_REQUEST_MESSAGE;
    return `${GENERIC_ERROR_MESSAGE} (Text API Call Error)`;
  }
}

// --- Main Message Processing ---
async function processMessage(message: Api.Message, chatId: bigint, userId: bigint, messageId: number): Promise<void> {
  let responseText: string | null = null;
  try {
    await client.sendTyping(chatId);

    if (message.text) {
      const messageText = message.text.trim();
      if (messageText.toLowerCase() === "/reset") {
        if (!kv) responseText = KV_ERROR_MESSAGE;
        else {
          try {
            const kvKey = [CONVERSATION_KV_PREFIX, chatId.toString(), "user", userId.toString()];
            await kv.delete(kvKey);
            responseText = RESET_CONFIRMATION_USER;
          } catch { responseText = RESET_ERROR; }
        }
      } else {
        responseText = await getGeminiTextResponse(chatId.toString(), userId.toString(), messageText, messageText);
      }
    } else if (message.media && !(message.document && message.document.mimeType === "application/geo-uri")) {
      responseText = MEDIA_UNSUPPORTED_MESSAGE;
    }

    if (responseText) {
      await client.sendMessage(chatId, { message: responseText, replyTo: messageId });
    }
  } catch (error: any) {
    try {
      const errorReply = `${GENERIC_ERROR_MESSAGE} (Detail: ${error.message || "Unknown error in processMessage"})`;
      await client.sendMessage(chatId, { message: errorReply, replyTo: messageId });
    } catch { }
  }
}

// --- GramJS Event Handler ---
async function handleNewMessage(event: NewMessageEvent): Promise<void> {
  const message = event.message;
  if (!message || !message.chatId || !message.senderId || !message.id) return;
  const chatId = message.chatId;
  const senderId = message.senderId;
  const messageId = message.id;

  if (!selfId) return;
  if (senderId.toString() === selfId.toString()) return;

  const chatType = event.isPrivate ? "private" : (event.isGroup ? "group" : (event.isChannel ? "channel" : "unknown"));
  let shouldProcess = false;

  if (chatType === "private") shouldProcess = true;
  else if (chatType === "group" || chatType === "channel") {
    if (ALLOWED_GROUP_ID_SETTING.toUpperCase() === "ALL") shouldProcess = true;
    else if (ALLOWED_GROUP_ID_SETTING && chatId.toString() === ALLOWED_GROUP_ID_SETTING) shouldProcess = true;
  }

  if (shouldProcess) {
    if (message.text || (message.media && !(message.document && message.document.mimeType === "application/geo-uri"))) {
      await processMessage(message, chatId, senderId, messageId);
    }
  }
}

// --- Start the Bot ---
async function runBot() {
  // Initialize KV store here if not already done
  if (!kv) {
    try {
      kv = await Deno.openKv();
    } catch { }
  }

  try {
    if (!client.connected) await client.connect();
    const me = await client.getMe();
    if (me && typeof me === "object" && "id" in me && me.id && (typeof me.id === "bigint" || typeof me.id === "number")) {
      selfId = typeof me.id === "bigint" ? me.id : BigInt(me.id);
      let username = "N/A";
      if ("username" in me && typeof me.username === "string" && me.username) username = me.username;
      let firstName = "";
      if ("firstName" in me && typeof me.firstName === "string" && me.firstName) firstName = me.firstName;
      let lastName = "";
      if ("lastName" in me && typeof me.lastName === "string" && me.lastName) lastName = me.lastName;
      console.log(`[RUN_BOT] ✅ Logged in as: ${firstName || ""} ${lastName || ""} (@${username}) - ID: ${selfId}`);
    } else {
      console.error("[RUN_BOT] ❌ CRITICAL: Could not get own user details or ID. The TELEGRAM_SESSION_STRING might be invalid or expired.");
      throw new Error("FAILED_TO_GET_SELF_ID_SESSION_INVALID_AT_STARTUP");
    }

    client.addEventHandler(handleNewMessage, new NewMessage({}));
    console.log("[RUN_BOT] 👂 Listening for new messages...");
  } catch (error: any) {
    if (error.message?.includes("SESSION_PASSWORD_NEEDED")) {
      console.error("🔒 Error Hint: 2FA Password might be required by session. Session string may be invalid/expired. Regenerate session.");
    } else if (
      error.message?.includes("Auth key must be generated") ||
      error.message?.includes("AUTH_KEY_UNREGISTERED") ||
      error.message?.includes("SESSION_REVOKED")
    ) {
      console.error("🔑 Error Hint: Session string invalid/corrupted/revoked/expired. Regenerate TELEGRAM_SESSION_STRING.");
    } else if (error.message?.includes("PHONE_CODE_INVALID")) {
      console.error("📞 Error Hint: Phone code (from previous session generation) was invalid. Regenerate session.");
    }
    console.error("🛑 Ensure TELEGRAM_SESSION_STRING is correctly set and valid.");
    throw error;
  }
}

// --- Run the Bot ---
await runBot();
