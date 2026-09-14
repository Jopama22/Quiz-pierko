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
  pdfInput: document.getElementById("pdfInput"),
  pdfStatus: document.getElementById("pdfStatus"),
  generateBtn: document.getElementById("generateBtn"),
  batchStatus: document.getElementById("batchStatus"),
  sendBtn: document.getElementById("sendBtn"),
  childQuestion: document.getElementById("childQuestion"),
  optionsList: document.getElementById("optionsList"),
  answerFeedback: document.getElementById("answerFeedback"),
  timelineList: document.getElementById("timelineList"),
  // Estos solo existen en configuracion.html
  providerSelect: document.getElementById("providerSelect"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  keyStatus: document.getElementById("keyStatus"),
};

// =======================================================
// CLAVE / PROVEEDOR (guardados en localStorage, compartidos entre páginas)
// =======================================================
function getProvider() {
  return localStorage.getItem("ai_provider") || "gemini";
}

function getApiKey() {
  return localStorage.getItem(`api_key_${getProvider()}`) || null;
}

// =======================================================
// INICIO
// =======================================================
init();

async function init() {
  if (el.providerSelect) initConfigPage();
  if (el.generateBtn) await initQuizPage();
}

// --- Página de configuración (configuracion.html) ---
function initConfigPage() {
  const provider = getProvider();
  el.providerSelect.value = provider;

  const savedKey = localStorage.getItem(`api_key_${provider}`);
  if (savedKey) {
    el.apiKeyInput.value = savedKey;
    el.keyStatus.textContent = "Clave guardada en este navegador.";
  }

  el.providerSelect.addEventListener("change", () => {
    const p = el.providerSelect.value;
    localStorage.setItem("ai_provider", p);
    const key = localStorage.getItem(`api_key_${p}`);
    el.apiKeyInput.value = key || "";
    el.keyStatus.textContent = key ? "Clave guardada en este navegador." : "";
  });

  el.saveKeyBtn.addEventListener("click", handleSaveApiKey);
}

function handleSaveApiKey() {
  const provider = el.providerSelect.value;
  const key = el.apiKeyInput.value.trim();
  localStorage.setItem("ai_provider", provider);
  if (!key) {
    localStorage.removeItem(`api_key_${provider}`);
    el.keyStatus.textContent = "Clave eliminada.";
    return;
  }
  localStorage.setItem(`api_key_${provider}`, key);
  el.keyStatus.textContent = "Clave guardada en este navegador. Ya puedes generar preguntas reales.";
}

// --- Página del quiz (index.html) ---
async function initQuizPage() {
  const apiKey = getApiKey();
  if (apiKey) {
    el.status.textContent =
      getProvider() === "gemini" ? "usando tu clave de Gemini" : "usando tu clave de Ollama Cloud";
  } else if (CONFIG.DEMO_MODE) {
    el.status.textContent = "modo demo (sin backend)";
  } else {
    await connectSupabase();
    subscribeToAnswers();
  }

  el.generateBtn.addEventListener("click", handleGenerateBatch);
  el.sendBtn.addEventListener("click", handleSendNextQuestion);
  el.pdfInput.addEventListener("change", handlePdfUpload);
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

  el.generateBtn.disabled = true;
  el.batchStatus.textContent = `Generando ${count} preguntas…`;

  try {
    const apiKey = getApiKey();
    if (apiKey) {
      questionBank = await generateQuestionsWithAI(apiKey, topic, count);
    } else if (!CONFIG.DEMO_MODE) {
      questionBank = await askBackendForQuestions(topic, count);
    } else {
      questionBank = await fakeGenerateQuestions(topic, count);
    }

    currentIndex = -1;
    el.batchStatus.textContent = `${questionBank.length} preguntas listas. Envía la primera cuando quieras.`;
    el.sendBtn.disabled = false;
  } catch (err) {
    el.batchStatus.textContent = `Error: ${err.message}`;
    console.error(err);
  } finally {
    el.generateBtn.disabled = false;
  }
}

// =======================================================
// LLAMADA A LA IA (Gemini u Ollama Cloud, según lo que el usuario eligió)
// =======================================================
const GEMINI_MODEL = "gemini-3.6-flash";
const OLLAMA_MODEL = "gpt-oss:120b"; // modelo gratuito disponible en Ollama Cloud

async function callAI(apiKey, prompt, forceJson) {
  return getProvider() === "ollama"
    ? callOllama(apiKey, prompt, forceJson)
    : callGemini(apiKey, prompt, forceJson);
}

async function callGemini(apiKey, prompt, forceJson, attempt = 1) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 1.0 },
  };
  if (forceJson) {
    body.generationConfig.responseMimeType = "application/json";
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    // Si el modelo está saturado (503), reintenta una vez después de una pausa breve
    if (res.status === 503 && attempt < 3) {
      await sleep(1500 * attempt);
      return callGemini(apiKey, prompt, forceJson, attempt + 1);
    }
    const errText = await res.text();
    throw new Error(`Error de Gemini (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini no devolvió texto. Respuesta completa: ${JSON.stringify(data)}`);
  }
  return text;
}

// Ollama Cloud usa su propio endpoint (https://ollama.com/api/generate) con
// autenticación por header "Authorization: Bearer <clave>", distinto al de Gemini.
async function callOllama(apiKey, prompt, forceJson, attempt = 1) {
  const res = await fetch("https://ollama.com/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: forceJson ? "json" : undefined,
      options: { temperature: 1.0 },
    }),
  });

  if (!res.ok) {
    if (res.status === 503 && attempt < 3) {
      await sleep(1500 * attempt);
      return callOllama(apiKey, prompt, forceJson, attempt + 1);
    }
    const errText = await res.text();
    throw new Error(`Error de Ollama (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (!data.response) {
    throw new Error(`Ollama no devolvió texto. Respuesta completa: ${JSON.stringify(data)}`);
  }
  return data.response;
}

// Límite de caracteres por fragmento que se manda a la IA en cada llamada,
// y cuántos fragmentos (repartidos a lo largo de todo el documento) se usan como muestra.
const MAX_TOPIC_CHARS = 12000;
const MAX_CHUNKS = 5;

// Divide un texto largo en varios fragmentos repartidos a lo largo de todo el
// documento (inicio, partes intermedias y final), con un poco de variación
// aleatoria en cada llamada para que no siempre tome exactamente los mismos puntos.
function sampleChunks(text, chunkSize, maxChunks) {
  if (text.length <= chunkSize) return [text];

  const totalPossible = Math.ceil(text.length / chunkSize);
  const numChunks = Math.min(maxChunks, totalPossible);
  const chunks = [];
  const maxStart = Math.max(text.length - chunkSize, 1);

  for (let i = 0; i < numChunks; i++) {
    const basePos = Math.floor((i * maxStart) / Math.max(numChunks - 1, 1));
    const jitter = Math.floor((Math.random() - 0.5) * chunkSize * 0.6);
    const start = Math.min(Math.max(basePos + jitter, 0), maxStart);
    chunks.push(text.slice(start, start + chunkSize));
  }
  return chunks;
}

async function generateQuestionsWithAI(apiKey, topic, count) {
  if (!topic) {
    return generateQuestionsForChunk(apiKey, "", count);
  }

  const chunks = sampleChunks(topic, MAX_TOPIC_CHARS, MAX_CHUNKS);

  if (chunks.length === 1) {
    return generateQuestionsForChunk(apiKey, chunks[0], count);
  }

  // Reparte la cantidad de preguntas entre los fragmentos, para cubrir todo el material
  el.batchStatus.textContent = `Material largo: generando preguntas de ${chunks.length} secciones repartidas en todo el documento…`;
  const perChunk = Math.ceil(count / chunks.length);
  let allQuestions = [];

  for (let i = 0; i < chunks.length; i++) {
    el.batchStatus.textContent = `Generando sección ${i + 1} de ${chunks.length}…`;
    const questions = await generateQuestionsForChunk(apiKey, chunks[i], perChunk);
    allQuestions = allQuestions.concat(questions);
  }

  return allQuestions.slice(0, count);
}

async function generateQuestionsForChunk(apiKey, chunkText, count) {
  const temaTexto = chunkText
    ? `Tema o material de referencia:\n"""${chunkText}"""`
    : `No se dio un tema específico: genera preguntas variadas de cultura general apropiadas para un niño (ciencia, animales, geografía, historia, curiosidades).`;

  const prompt = `Eres un generador de preguntas educativas de opción múltiple para un niño.
Genera exactamente ${count} preguntas. Cada pregunta debe tener 4 alternativas y un
"correctIndex" (0 a 3) indicando cuál es la correcta.
Varía el enfoque y la redacción de las preguntas — evita repetir siempre las mismas preguntas obvias sobre el tema.

${temaTexto}

Responde ÚNICAMENTE con un JSON válido (un array), sin texto adicional ni bloques de código, con este formato exacto:
[{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0}]`;

  const raw = await callAI(apiKey, prompt, true);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`La IA no devolvió un JSON válido: ${cleaned.slice(0, 200)}`);
  }
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
  const label = topic || "cultura general";
  const bank = [];
  for (let i = 1; i <= count; i++) {
    const correctIndex = Math.floor(Math.random() * 4);
    const options = [0, 1, 2, 3].map((n) =>
      n === correctIndex
        ? `Opción correcta sobre "${label}" (#${i})`
        : `Opción distractora ${n + 1} (#${i})`
    );
    bank.push({
      question: `Pregunta ${i} sobre "${label}": ¿cuál de estas opciones es correcta?`,
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
      ? await reviewAnswerWithAI(apiKey, item, selectedIndex, isCorrect)
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

async function reviewAnswerWithAI(apiKey, item, selectedIndex, isCorrect) {
  const prompt = `Un niño respondió una pregunta de un quiz educativo.
Pregunta: "${item.question}"
Alternativas: ${item.options.join(" | ")}
Respuesta correcta: "${item.options[item.correctIndex]}"
El niño eligió: "${item.options[selectedIndex]}" (${isCorrect ? "correcta" : "incorrecta"})

Da una explicación breve (1-2 frases), cálida y alentadora, en español, dirigida directamente al niño.
Responde solo con la explicación, sin comillas ni texto extra.`;

  return (await callAI(apiKey, prompt, false)).trim();
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
