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

  const provider = (process.env.LLM_PROVIDER || "glm").toLowerCase();
  const errors = [];

  try {
    if (provider === "glm") {
      try {
        console.log("[researcher] Trying Zhipu GLM...");
        const res = await glmChat(messages, []);
        if (res.content) return res.content;
      } catch (err) {
        console.warn("[researcher] Zhipu GLM research failed:", err.message || err);
        errors.push(`GLM: ${err.message || err}`);
      }
    }

    // Fallback to Groq if GLM failed or if Groq is selected
    if (process.env.GROQ_API_KEY) {
      try {
        console.log("[researcher] Trying Groq...");
        const res = await groqChat(messages, []);
        if (res.content) return res.content;
      } catch (err) {
        console.warn("[researcher] Groq research failed:", err.message || err);
        errors.push(`Groq: ${err.message || err}`);
      }
    }

    // Final fallback to Gemini
    if (process.env.GEMINI_API_KEY) {
      try {
        console.log("[researcher] Trying Gemini...");
        const { geminiGenerate } = await import("../lib/gemini.js");
        const contents = [
          { role: "user", parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
        ];
        const data = await geminiGenerate({ contents });
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } catch (err) {
        console.warn("[researcher] Gemini research failed:", err.message || err);
        errors.push(`Gemini: ${err.message || err}`);
      }
    }

    throw new Error(`All LLM providers failed to generate research report.`);
  } catch (error) {
    import("node:fs").then((fs) => {
      fs.writeFileSync(
        "C:\\Users\\ASUS\\.gemini\\antigravity-ide\\brain\\5e8a8cf1-2655-4381-993d-b6cd14629862\\research_error.log",
        `Topic: ${topic}\nTime: ${new Date().toISOString()}\nErrors:\n${errors.join("\n")}\nStack: ${error.stack || error}\n`
      );
    }).catch(() => {});
    throw error;
  }
}
