import { TelegramClient } from 'npm:telegram';
import { StringSession } from 'npm:telegram/sessions/index.js';
import "jsr:@std/dotenv/load"; // Auto-loads .env

console.log("--- Telegram Session String Generation Script (Deno on Cloud Shell) ---");
console.log("This script will guide you through an interactive login to get a new Telegram session string.");
console.log("Ensure TELEGRAM_API_ID and TELEGRAM_API_HASH are in your .env file.");

const API_ID_STR = Deno.env.get("TELEGRAM_API_ID");
const API_HASH = Deno.env.get("TELEGRAM_API_HASH");

if (!API_ID_STR || !API_HASH) {
    console.error("❌ FATAL_CONFIG: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in the .env file.");
    Deno.exit(1);
}
const API_ID = parseInt(API_ID_STR);
if (isNaN(API_ID)) {
    console.error("❌ FATAL_CONFIG: TELEGRAM_API_ID must be a number.");
    Deno.exit(1);
}

const stringSession = new StringSession(""); // Always start empty for new session
const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
    baseLogger: undefined, // Use default logger
});

async function performInteractiveLogin() {
    console.log("🚀 Initializing Telegram Client for new session generation...");
    try {
        await client.start({
            phoneNumber: async () => {
                const number = prompt("📞 Enter your phone number (international format, e.g., +959...):");
                if (number === null || number.trim() === "") throw new Error("Phone number cannot be empty.");
                return number;
            },
            password: async () => prompt("🔑 Enter your Telegram password (2FA, press Enter if none):") || "",
            phoneCode: async () => {
                const code = prompt("💬 Enter the code you received via Telegram:");
                if (code === null || code.trim() === "") throw new Error("Phone code cannot be empty.");
                return code;
            },
            onError: (err: Error) => {
                console.error("Login Error during client.start:", err.message || err);
                if ((err as any).errorMessage === 'SESSION_PASSWORD_NEEDED') {
                     console.error("Hint: A 2FA password is required for this account.");
                }
                if (err.stack) console.error("Error stack:", err.stack);
            },
        });

        const generatedSession = client.session.save();
        console.log("\n✅ New login successful!");
        console.log("🔒 NEW TELEGRAM_SESSION_STRING (Copy this entire string carefully):");
        console.log("===================================================================");
        console.log(generatedSession);
        console.log("===================================================================");
        console.log("🛑 Update your .env file (or Deno Deploy secrets) with this new session string.");

    } catch (error: any) {
        console.error("💥 Failed to get session string during new login:", error.message || error);
    } finally {
        if (client.connected) {
            await client.disconnect();
            console.log("👋 Client disconnected after session generation.");
        }
        console.log("--- Session generation script finished ---");
    }
}

if (Deno.args.includes("--non-interactive")) {
    console.error("❌ This script requires interactive prompts for session generation.");
    Deno.exit(1);
} else {
    await performInteractiveLogin();
  }
      
