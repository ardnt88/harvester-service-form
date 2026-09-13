const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

const WATI_API_TOKEN = process.env.WATI_API_TOKEN;
const WATI_ENDPOINT = "https://live-mt-server.wati.io/319222";
const PHONE_ID = "+6281112701970";
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// Session storage (in-memory, resets on redeploy)
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Session structure
class Session {
  constructor(phoneNumber, userName) {
    this.phoneNumber = phoneNumber;
    this.userName = userName;
    this.messages = [];
    this.photos = [];
    this.startTime = new Date();
    this.lastActivityTime = Date.now();
    this.state = "active"; // active, waiting_summary, ended
  }

  addMessage(role, content) {
    this.messages.push({ role, content });
    this.lastActivityTime = Date.now();
  }

  addPhoto(photoUrl) {
    if (this.photos.length < 3) {
      this.photos.push(photoUrl);
    }
  }

  getTranscript() {
    return this.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  }

  isTimedOut() {
    return Date.now() - this.lastActivityTime > SESSION_TIMEOUT;
  }
}

// Send message to user via WATI
async function sendToWATI(phoneNumber, message, mediaUrl = null) {
  try {
    const payload = {
      custom_json_meta: {
        source: "harvester_bot",
      },
    };

    if (mediaUrl) {
      payload.message_media_url = mediaUrl;
      payload.message_type = "MEDIA";
    } else {
      payload.message_body = message;
      payload.message_type = "TEXT";
    }

    const response = await fetch(`${WATI_ENDPOINT}/sendMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WATI_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone_number: phoneNumber,
        ...payload,
      }),
    });

    if (!response.ok) {
      console.error("WATI error:", await response.text());
    }
  } catch (error) {
    console.error("Error sending to WATI:", error);
  }
}

// Chat with Claude
async function chatWithClaude(messages) {
  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      system: `You are a helpful agricultural assistant for the Rize harvester reporting system.
        You help farmers report harvest data by asking clarifying questions about:
        - Harvest date and time
        - Type of crop harvested
        - Quantity harvested
        - Weather conditions
        - Equipment used

        Be friendly, concise, and guide them through the reporting process.
        Ask one question at a time.`,
      messages: messages,
    });

    return response.content[0].text;
  } catch (error) {
    console.error("Claude API error:", error);
    return "Sorry, I had an error. Please try again.";
  }
}

// Summarize conversation
async function summarizeConversation(session) {
  const transcript = session.getTranscript();

  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 500,
      system: `Summarize this harvest report conversation. Extract key information:
        - Topics discussed
        - Important details mentioned
        - Keep it concise (2-3 sentences max)`,
      messages: [
        {
          role: "user",
          content: `Conversation:\n${transcript}`,
        },
      ],
    });

    return response.content[0].text;
  } catch (error) {
    console.error("Summarization error:", error);
    return "Conversation summary not available";
  }
}

// Submit to Google Sheets via Apps Script
async function submitToSheet(session, summary) {
  try {
    const duration = Math.round((Date.now() - session.startTime) / 1000 / 60); // minutes

    const payload = {
      userPhone: session.phoneNumber,
      userName: session.userName,
      sessionDuration: `${duration} min`,
      transcript: session.getTranscript(),
      summary: summary,
      photo1Url: session.photos[0] || "",
      photo2Url: session.photos[1] || "",
      photo3Url: session.photos[2] || "",
      topics: extractTopics(summary),
    };

    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log("Sheet submission result:", result);
    return result.success;
  } catch (error) {
    console.error("Sheet submission error:", error);
    return false;
  }
}

// Extract topics from summary
function extractTopics(summary) {
  // Simple extraction - could be improved
  return summary.split(".")[0];
}

// Main webhook handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(400).json({ error: "Only POST allowed" });
  }

  try {
    const { messages } = req.body;

    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: "No messages" });
    }

    const message = messages[0];
    const phoneNumber = message.contact.wa_id;
    const userName = message.contact.profile.name;
    const incomingText = message.text?.body || "";

    console.log(`Message from ${phoneNumber} (${userName}): ${incomingText}`);

    // Check for keyword
    if (incomingText.toLowerCase().includes("laporan panen")) {
      // Start new session
      const session = new Session(phoneNumber, userName);
      sessions.set(phoneNumber, session);

      const greeting =
        "Halo! Saya siap membantu Anda melaporkan hasil panen. Bisa ceritakan tanggal dan waktu panen Anda?";
      await sendToWATI(phoneNumber, greeting);

      return res.json({ success: true, action: "session_started" });
    }

    // Get existing session
    let session = sessions.get(phoneNumber);

    if (!session) {
      return res.json({
        success: false,
        message: "No active session. Say 'laporan panen' to start.",
      });
    }

    // Check timeout
    if (session.isTimedOut()) {
      await sendToWATI(
        phoneNumber,
        "Sesi Anda telah berakhir karena tidak ada aktivitas selama 30 menit."
      );
      sessions.delete(phoneNumber);
      return res.json({ success: true, action: "session_timeout" });
    }

    // Check for end command
    if (incomingText.toUpperCase() === "KIRIM") {
      const summary = await summarizeConversation(session);
      const success = await submitToSheet(session, summary);

      if (success) {
        await sendToWATI(
          phoneNumber,
          `Terima kasih! Laporan panen Anda telah disimpan.\n\nRingkasan:\n${summary}`
        );
      } else {
        await sendToWATI(
          phoneNumber,
          "Ada kesalahan saat menyimpan. Silakan coba lagi."
        );
      }

      sessions.delete(phoneNumber);
      return res.json({ success: true, action: "session_ended" });
    }

    // Handle photos
    if (message.image) {
      const photoUrl = message.image.link;
      session.addPhoto(photoUrl);

      if (session.photos.length < 3) {
        const remaining = 3 - session.photos.length;
        await sendToWATI(
          phoneNumber,
          `Foto ${session.photos.length} diterima. Silakan kirim ${remaining} foto lagi sebagai bukti.`
        );
      } else {
        await sendToWATI(
          phoneNumber,
          "Terima kasih! Saya sudah menerima 3 foto bukti. Ketik KIRIM untuk menyelesaikan laporan."
        );
      }

      return res.json({ success: true, action: "photo_received" });
    }

    // Regular chat message
    if (incomingText.trim()) {
      session.addMessage("user", incomingText);

      const claudeResponse = await chatWithClaude(session.messages);
      session.addMessage("assistant", claudeResponse);

      await sendToWATI(phoneNumber, claudeResponse);
    }

    return res.json({ success: true, action: "message_processed" });
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({ error: error.message });
  }
}
