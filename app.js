// =======================================================
// CONFIGURACIÓN — completa esto cuando tengas tus claves
// =======================================================
// ⚠️ La clave de Gemini NUNCA debe ir aquí (este archivo es público en GitHub Pages).
// En su lugar, apunta BACKEND_ENDPOINT a una función backend (Supabase Edge
// Function / Cloudflare Worker) que guarde la clave de forma segura y llame a Gemini.
const CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU-ANON-KEY-PUBLICA", // esta sí es pública, está diseñada para el frontend
  BACKEND_ENDPOINT: "https://TU-PROYECTO.functions.supabase.co/ask-gemini",
  DEMO_MODE: true, // ponlo en false cuando conectes Supabase y el backend real
};

// =======================================================
// ESTADO
// =======================================================
let questionBank = [];   // [{ question, options: [...4], correctIndex }]
let currentIndex = -1;
let supabaseClient = null;

// =======================================================
// ELEMENTOS
// =======================================================
const el = {
  status: document.getElementById("connectionStatus"),
  topicInput: document.getElementById("topicInput"),
  countInput: document.getElementById("countInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  keyStatus: document.getElementById("keyStatus"),
  pdfInput: document.getElementById("pdfInput"),
  pdfStatus: document.getElementById("pdfStatus"),
  generateBtn: document.getElementById("generateBtn"),
  batchStatus: document.getElementById("batchStatus"),
  sendBtn: document.getElementById("sendBtn"),
  childQuestion: document.getElementById("childQuestion"),
  optionsList: document.getElementById("optionsList"),
  answerFeedback: document.getElementById("answerFeedback"),
  timelineList: document.getElementById("timelineList"),
};

// =======================================================
// INICIO
// =======================================================
init();

async function init() {
  if (CONFIG.DEMO_MODE) {
    el.status.textContent = "modo demo (sin backend)";
  } else {
    await connectSupabase();
    subscribeToAnswers();
  }

  const savedKey = localStorage.getItem("gemini_api_key");
  if (savedKey) {
    el.apiKeyInput.value = savedKey;
    el.keyStatus.textContent = "Clave guardada en este navegador.";
  }

  el.saveKeyBtn.addEventListener("click", handleSaveApiKey);
  el.generateBtn.addEventListener("click", handleGenerateBatch);
  el.sendBtn.addEventListener("click", handleSendNextQuestion);
  el.pdfInput.addEventListener("change", handlePdfUpload);
}

function handleSaveApiKey() {
  const key = el.apiKeyInput.value.trim();
  if (!key) {
    localStorage.removeItem("gemini_api_key");
    el.keyStatus.textContent = "Clave eliminada.";
    return;
  }
  localStorage.setItem("gemini_api_key", key);
  el.keyStatus.textContent = "Clave guardada en este navegador. Ya puedes generar preguntas reales.";
}

function getApiKey() {
  return localStorage.getItem("gemini_api_key") || null;
}

// =======================================================
// 0. SUBIR PDF Y EXTRAER TEXTO (se usa como material del RAG)
// =======================================================
async function handlePdfUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  el.pdfStatus.textContent = "Leyendo PDF…";
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = "";
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(" ");
      fullText += pageText + "\n\n";
    }

    el.topicInput.value = fullText.trim();
    el.pdfStatus.textContent = `Listo: se extrajeron ${pdf.numPages} página(s) de "${file.name}".`;

    // En producción, además de rellenar el textarea, conviene mandar este texto
    // a tu backend para trocearlo, generar embeddings y guardarlo en Supabase
    // (así el RAG puede buscar el fragmento más relevante, no todo el PDF entero).
    if (!CONFIG.DEMO_MODE) {
      await ingestTextForRag(fullText, file.name);
    }
  } catch (err) {
    el.pdfStatus.textContent = "No se pudo leer el PDF. Intenta con otro archivo.";
    console.error(err);
  }
}

// Llamada real: tu backend trocea el texto, genera embeddings con Gemini
// y los guarda en una tabla vectorial de Supabase (pgvector) para el RAG.
async function ingestTextForRag(text, sourceName) {
  const res = await fetch(CONFIG.BACKEND_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "ingest_document", text, sourceName }),
  });
  if (!res.ok) throw new Error("Fallo al indexar el documento");
}

// =======================================================
// 1. GENERAR LOTE DE PREGUNTAS CON ALTERNATIVAS (usa RAG como contexto)
// =======================================================
async function handleGenerateBatch() {
  const topic = el.topicInput.value.trim();
  let count = parseInt(el.countInput.value, 10) || 20;
  count = Math.min(Math.max(count, 1), 100); // límite 1–100
  el.countInput.value = count;

  if (!topic) {
    el.batchStatus.textContent = "Escribe primero un tema o material de referencia.";
    return;
  }

  el.generateBtn.disabled = true;
  el.batchStatus.textContent = `Generando ${count} preguntas…`;

  try {
    const apiKey = getApiKey();
    if (apiKey) {
      questionBank = await generateQuestionsWithGemini(apiKey, topic, count);
    } else if (!CONFIG.DEMO_MODE) {
      questionBank = await askBackendForQuestions(topic, count);
    } else {
      questionBank = await fakeGenerateQuestions(topic, count);
    }

    currentIndex = -1;
    el.batchStatus.textContent = `${questionBank.length} preguntas listas. Envía la primera cuando quieras.`;
    el.sendBtn.disabled = false;
  } catch (err) {
    el.batchStatus.textContent = "No se pudo generar el lote. Revisa tu clave de API o intenta de nuevo.";
    console.error(err);
  } finally {
    el.generateBtn.disabled = false;
  }
}

// =======================================================
// LLAMADA DIRECTA A GEMINI (usando la clave que el usuario guardó en su navegador)
// =======================================================
const GEMINI_MODEL = "gemini-2.0-flash";

async function callGemini(apiKey, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error de Gemini: ${errText}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function generateQuestionsWithGemini(apiKey, topic, count) {
  const prompt = `Eres un generador de preguntas educativas de opción múltiple para un niño.
Genera exactamente ${count} preguntas basadas en el siguiente tema o material. Cada pregunta debe tener
4 alternativas y un "correctIndex" (0 a 3) indicando cuál es la correcta.

Responde ÚNICAMENTE con un JSON válido, sin texto adicional ni bloques de código, con este formato exacto:
[{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0}]

Tema o material:
"""${topic}"""`;

  const raw = await callGemini(apiKey, prompt);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// Llamada real: tu backend hace la búsqueda RAG (embeddings + contexto) y le pide
// a Gemini un JSON así: { questions: [ { question, options: [4], correctIndex }, ... ] }
async function askBackendForQuestions(topic, count) {
  const res = await fetch(CONFIG.BACKEND_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "generate_questions", topic, count }),
  });
  if (!res.ok) throw new Error("Fallo al generar las preguntas");
  const data = await res.json();
  return data.questions;
}

// Simulación local para probar la interfaz sin backend todavía
async function fakeGenerateQuestions(topic, count) {
  await sleep(700);
  const bank = [];
  for (let i = 1; i <= count; i++) {
    const correctIndex = Math.floor(Math.random() * 4);
    const options = [0, 1, 2, 3].map((n) =>
      n === correctIndex
        ? `Opción correcta sobre "${topic}" (#${i})`
        : `Opción distractora ${n + 1} (#${i})`
    );
    bank.push({
      question: `Pregunta ${i} sobre "${topic}": ¿cuál de estas opciones es correcta?`,
      options,
      correctIndex,
    });
  }
  return bank;
}

// =======================================================
// 2. ENVIAR LA SIGUIENTE PREGUNTA DEL LOTE (se guarda y aparece en el panel del hijo + timeline)
// =======================================================
async function handleSendNextQuestion() {
  currentIndex++;
  if (currentIndex >= questionBank.length) {
    el.batchStatus.textContent = "Ya se enviaron todas las preguntas del lote.";
    el.sendBtn.disabled = true;
    return;
  }

  const item = questionBank[currentIndex];
  el.batchStatus.textContent = `Pregunta ${currentIndex + 1} de ${questionBank.length} enviada.`;
  addTimelineItem("Pregunta enviada", item.question, "question");

  renderQuestionForChild(item);

  if (!CONFIG.DEMO_MODE) {
    await supabaseClient.from("quiz_turns").insert({
      type: "question",
      content: item.question,
      options: item.options,
      correct_index: item.correctIndex,
    });
  }
}

// =======================================================
// 3. VISTA DEL HIJO: pregunta + botones de alternativas
// =======================================================
function renderQuestionForChild(item) {
  el.childQuestion.textContent = item.question;
  el.answerFeedback.textContent = "";
  el.optionsList.innerHTML = "";

  item.options.forEach((optionText, index) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.textContent = optionText;
    btn.addEventListener("click", () => handleChildAnswer(index, item, btn));
    el.optionsList.appendChild(btn);
  });
}

// =======================================================
// 4. EL HIJO ELIGE UNA ALTERNATIVA (esto es lo que verías "en tiempo real")
// =======================================================
async function handleChildAnswer(selectedIndex, item, clickedBtn) {
  const isCorrect = selectedIndex === item.correctIndex;

  // Bloquea todos los botones y marca correcto/incorrecto visualmente
  const allButtons = el.optionsList.querySelectorAll(".option-btn");
  allButtons.forEach((btn, i) => {
    btn.disabled = true;
    if (i === item.correctIndex) btn.classList.add("option-btn--correct");
    if (i === selectedIndex && !isCorrect) btn.classList.add("option-btn--wrong");
  });

  el.answerFeedback.textContent = isCorrect ? "¡Correcto! 🎉" : "No era esa, pero buen intento.";

  addTimelineItem(
    "Respuesta",
    `${item.options[selectedIndex]} ${isCorrect ? "(correcta)" : "(incorrecta)"}`,
    "answer"
  );

  if (!CONFIG.DEMO_MODE) {
    await supabaseClient.from("quiz_turns").insert({
      type: "answer",
      content: item.options[selectedIndex],
      is_correct: isCorrect,
    });
  }

  // La IA revisa la respuesta y da una explicación breve (esto sí usa el modelo,
  // no solo la comparación de índices)
  await showAiReview(item, selectedIndex, isCorrect);
}

// =======================================================
// 5. LA IA REVISA LA RESPUESTA Y EXPLICA POR QUÉ
// =======================================================
async function showAiReview(item, selectedIndex, isCorrect) {
  el.answerFeedback.textContent += " · la IA está revisando…";

  try {
    const apiKey = getApiKey();
    const explanation = apiKey
      ? await reviewAnswerWithGemini(apiKey, item, selectedIndex, isCorrect)
      : CONFIG.DEMO_MODE
      ? await fakeAiReview(item, selectedIndex, isCorrect)
      : await askBackendToReview(item, selectedIndex, isCorrect);

    el.answerFeedback.textContent = (isCorrect ? "¡Correcto! 🎉 " : "No era esa. ") + explanation;
    addTimelineItem("Comentario de la IA", explanation, "review");

    if (!CONFIG.DEMO_MODE && !apiKey) {
      await supabaseClient.from("quiz_turns").insert({
        type: "review",
        content: explanation,
      });
    }
  } catch (err) {
    console.error(err);
  }
}

async function reviewAnswerWithGemini(apiKey, item, selectedIndex, isCorrect) {
  const prompt = `Un niño respondió una pregunta de un quiz educativo.
Pregunta: "${item.question}"
Alternativas: ${item.options.join(" | ")}
Respuesta correcta: "${item.options[item.correctIndex]}"
El niño eligió: "${item.options[selectedIndex]}" (${isCorrect ? "correcta" : "incorrecta"})

Da una explicación breve (1-2 frases), cálida y alentadora, en español, dirigida directamente al niño.
Responde solo con la explicación, sin comillas ni texto extra.`;

  return (await callGemini(apiKey, prompt)).trim();
}

// Llamada real: tu backend le manda a Gemini la pregunta, las alternativas,
// cuál eligió tu hijo y cuál era la correcta, y pide una explicación breve.
async function askBackendToReview(item, selectedIndex, isCorrect) {
  const res = await fetch(CONFIG.BACKEND_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "review_answer",
      question: item.question,
      options: item.options,
      correctIndex: item.correctIndex,
      selectedIndex,
    }),
  });
  if (!res.ok) throw new Error("Fallo al revisar la respuesta");
  const data = await res.json();
  return data.explanation;
}

// Simulación local
async function fakeAiReview(item, selectedIndex, isCorrect) {
  await sleep(500);
  return isCorrect
    ? `Bien hecho: "${item.options[item.correctIndex]}" es la respuesta que mejor encaja con el tema.`
    : `La correcta era "${item.options[item.correctIndex]}". Repásalo y sigue intentando.`;
}

// =======================================================
// SUPABASE: conexión y suscripción en tiempo real
// =======================================================
async function connectSupabase() {
  // Requiere incluir el SDK de Supabase en index.html, por ejemplo:
  // <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  supabaseClient = window.supabase.createClient(
    CONFIG.SUPABASE_URL,
    CONFIG.SUPABASE_ANON_KEY
  );
  el.status.textContent = "conectado";
}

function subscribeToAnswers() {
  supabaseClient
    .channel("quiz_turns_channel")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "quiz_turns" },
      (payload) => {
        const { type, content, is_correct } = payload.new;
        if (type === "answer") {
          const suffix = is_correct ? "(correcta)" : "(incorrecta)";
          addTimelineItem("Respuesta (en vivo)", `${content} ${suffix}`, "answer");
        }
        if (type === "review") {
          addTimelineItem("Comentario de la IA (en vivo)", content, "review");
        }
      }
    )
    .subscribe();
}

// =======================================================
// UI: línea de tiempo
// =======================================================
function addTimelineItem(who, text, kind) {
  const li = document.createElement("li");
  li.className = `timeline__item ${kind === "answer" ? "timeline__item--answer" : ""}`;
  li.innerHTML = `<span class="timeline__who">${who}</span>${text}`;
  el.timelineList.appendChild(li);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
