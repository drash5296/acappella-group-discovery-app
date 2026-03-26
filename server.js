require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// モデル優先順位: 3.1 Flash Lite (500RPD) → 2.5 Flash (20RPD) フォールバック
const MODELS = ['gemini-3.1-flash-lite-preview', 'gemini-2.5-flash'];

async function generateWithFallback(params) {
  for (const model of MODELS) {
    try {
      const result = await ai.models.generateContent({ ...params, model });
      console.log(`✓ Used model: ${model}`);
      return result;
    } catch (err) {
      const status = err.message?.match(/status: (\d+)/)?.[1];
      if (status === '503' || status === '429') {
        console.warn(`⚠ ${model} unavailable (${status}), trying next...`);
        continue;
      }
      throw err; // 503/429以外のエラーはそのまま投げる
    }
  }
  throw new Error('All models unavailable');
}

const SYSTEM_INSTRUCTION = `You are an a cappella music discovery expert with deep knowledge of vocal groups worldwide.
Your role is to ask targeted questions (rated 1–10 by the user) to understand their music preferences,
then recommend a cappella groups and songs tailored to their taste.

You know both domestic Japanese a cappella groups (e.g., Rak, Vocal Asia members, university a cappella clubs,
SING LIKE TALKING vocal arrangements, etc.) and international groups (e.g., Pentatonix, Straight No Chaser,
The Real Group, Naturally 7, Vox One, Take 6, The Swingle Singers, Home Free, Acappella, Rockapella,
Rajaton, Perpetuum Jazzile, etc.).

When generating questions:
- Focus on ONE specific preference dimension per question (genre, complexity, energy, language, size, tone, etc.)
- Make the 1 and 10 endpoints vivid and contrasting
- Build dynamically on previous answers — if they rated "complex harmony" high, dig deeper into that
- Be creative: go beyond obvious questions like "pop vs jazz"
- Questions should feel like a natural conversation with a music expert

Always return valid JSON only, no extra text, no markdown code fences.`;

// ─── Generate next question ───────────────────────────────────────────────────
app.post('/api/next-question', async (req, res) => {
  const { history = [], questionNumber } = req.body;

  const historyText = history.length > 0
    ? 'Previous Q&A:\n' + history.map((h, i) =>
        `Q${i + 1}: ${h.question}\n  (1=${h.label1} / 10=${h.label10})\n  Answer: ${h.answer}/10`
      ).join('\n')
    : '';

  const guidance = questionNumber === 1
    ? 'This is question 1 — start with a broad but interesting preference (e.g., harmony complexity vs. rhythmic drive).'
    : `Based on the answers so far, choose the dimension that will MOST help narrow down the ideal a cappella groups. Avoid repeating similar dimensions.`;

  const prompt = `${historyText ? historyText + '\n\n' : ''}${guidance}

Generate question ${questionNumber} of 10.

Return ONLY this JSON (no markdown, no explanation):
{
  "question": "Engaging question text in Japanese",
  "label1": "What score 1 means (Japanese, 4–8 chars)",
  "label10": "What score 10 means (Japanese, 4–8 chars)"
}`;

  try {
    const result = await generateWithFallback({
      contents: prompt,
      config: { systemInstruction: SYSTEM_INSTRUCTION }
    });
    const raw = result.text;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const json = JSON.parse(cleaned);
    res.json(json);
  } catch (err) {
    console.error('next-question error:', err);
    res.status(500).json({ error: '質問の生成に失敗しました。' });
  }
});

// ─── Generate recommendations ─────────────────────────────────────────────────
app.post('/api/recommend', async (req, res) => {
  const { history } = req.body;

  if (!history || history.length === 0) {
    return res.status(400).json({ error: '回答履歴がありません。' });
  }

  const historyText = history.map((h, i) =>
    `Q${i + 1}: ${h.question}\n  (1=${h.label1} / 10=${h.label10})\n  Answer: ${h.answer}/10`
  ).join('\n');

  const prompt = `The user answered all 10 questions. Here are their results:

${historyText}

Analyze their preferences deeply and recommend the most suitable a cappella groups and songs.
Include a mix of Japanese domestic groups and international groups as appropriate to their taste.
Be specific — name real groups and real songs.

Return ONLY this JSON (no markdown, no explanation):
{
  "summary": "2–3 sentences in Japanese describing what you discovered about their taste",
  "groups": [
    {
      "name": "Group name",
      "origin": "Country or region in Japanese",
      "style": "Musical style / genre tags (Japanese, comma-separated)",
      "description": "2–3 sentences in Japanese about their sound and why this user will love them",
      "starter_song": "One specific recommended song title",
      "match_points": ["reason 1 in Japanese", "reason 2 in Japanese"]
    }
  ],
  "songs": [
    {
      "title": "Song title",
      "group": "Performing group",
      "why": "One sentence in Japanese explaining why this song fits"
    }
  ]
}

Recommend exactly 4 groups and 4 songs. Prioritize specificity and genuine fit over variety.`;

  try {
    const result = await generateWithFallback({
      contents: prompt,
      config: { systemInstruction: SYSTEM_INSTRUCTION }
    });
    const raw = result.text;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const json = JSON.parse(cleaned);
    res.json(json);
  } catch (err) {
    console.error('recommend error:', err);
    res.status(500).json({ error: 'おすすめの生成に失敗しました。' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server running at http://localhost:${PORT}`);
});
