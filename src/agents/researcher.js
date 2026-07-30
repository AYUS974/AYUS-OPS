import { glmChat } from "../lib/glm.js";
import { groqChat } from "../lib/groq.js";

/**
 * Research agent (Arjun) compiling a comprehensive research report.
 * 
 * @param {string} topic - the topic to research
 * @returns {Promise<string>} detailed markdown research report
 */
export async function performResearch(topic) {
  const systemPrompt = `You are Arjun, the Research Agent of AYUS Labs. You are a world-class researcher with exceptional analytical skills, attention to detail, and a structured, logical mind. 
Your goal is to compile a highly detailed, professional, and comprehensive research report on any topic requested.
Your research must have the qualities of a top-tier industry analyst:
1. Deep, detailed overview of the topic.
2. Core concepts, architectural patterns, or technical fundamentals.
3. Current state-of-the-art developments and industry trends.
4. Key challenges, risks, opportunities, and future outlook.
5. Well-structured, clear markdown format with headings, bullet points, and tables if applicable.

Do not write brief or superficial summaries. Provide a thorough, deep-dive report that Anish (the founder) can rely on for business or engineering decisions.`;

  const userPrompt = `Please perform comprehensive, detailed research on the following topic:\n\n"${topic}"`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  const errors = [];

  // Groq first: a full report is a long generation, and Gemini's free tier
  // 429s on it for 40-60s at a time — which strands the caller (AYUS goes
  // silent mid-conversation waiting for Arjun). Gemini stays as last resort.
  try {
    if (process.env.GROQ_API_KEY) {
      try {
        console.log("[researcher] Trying Groq...");
        // Default cap is 1200 — a full report gets guillotined mid-sentence and
        // the truncated text goes straight into whatever email quotes it.
        const res = await groqChat(messages, [], { maxTokens: 4000 });
        if (res.content) return res.content;
      } catch (err) {
        console.warn("[researcher] Groq research failed:", err.message || err);
        errors.push(`Groq: ${err.message || err}`);
      }
    }

    if (process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY) {
      try {
        console.log("[researcher] Trying Zhipu GLM...");
        const res = await glmChat(messages, []);
        if (res.content) return res.content;
      } catch (err) {
        console.warn("[researcher] Zhipu GLM research failed:", err.message || err);
        errors.push(`GLM: ${err.message || err}`);
      }
    }

    if (process.env.GEMINI_API_KEY) {
      try {
        console.log("[researcher] Trying Gemini...");
        const { geminiGenerate } = await import("../lib/gemini.js");
        const contents = [
          { role: "user", parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
        ];
        // Bounded: better to hand back a failure AYUS can voice than to hold
        // the conversation open through minutes of 429 backoff.
        const data = await geminiGenerate({ contents }, { attempts: 2, deadlineMs: 60_000 });
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } catch (err) {
        console.warn("[researcher] Gemini research failed:", err.message || err);
        errors.push(`Gemini: ${err.message || err}`);
      }
    }

    throw new Error(`All LLM providers failed to generate research report.`);
  } catch (error) {
    console.error(`[researcher] "${topic}" failed:`, errors.join(" | ") || error.message);
    throw error;
  }
}
