# Preguntas para ti 🧠

Una app web sencilla para hacerle preguntas de opción múltiple a mi hijo, que vive en otra ciudad, y ver sus respuestas en tiempo real. Las preguntas se generan con IA (Gemini) a partir de un tema o de un PDF que subas.

## ¿Qué hace?

- Generas un lote de preguntas (1 a 100) con 4 alternativas cada una, sobre un tema que escribas o un PDF que subas.
- Le envías las preguntas una por una.
- Tu hijo responde tocando una alternativa y ve al instante si acertó.
- La IA revisa la respuesta y da una breve explicación.
- Todo queda registrado en una línea de tiempo compartida.

## Archivos

- `index.html` — estructura de la página.
- `style.css` — estilos.
- `app.js` — toda la lógica: generación de preguntas, PDF, llamadas a la IA.

## Cómo usarlo

1. Abre `index.html` (o el link de GitHub Pages).
2. Pega tu propia **API key de Gemini** en el campo correspondiente y dale "Guardar clave".
   - Se guarda solo en tu navegador (`localStorage`), nunca en el código.
   - Consíguela gratis en https://aistudio.google.com/apikey
3. Escribe un tema o sube un PDF con el material de referencia.
4. Elige cuántas preguntas quieres y genera el lote.
5. Ve enviando las preguntas una por una.

## Modo demo

Si no pones ninguna API key, la app funciona en modo demo con preguntas de ejemplo, para probar la interfaz sin conexión a ninguna IA.

## Nota de seguridad

La clave de API se usa directamente desde el navegador. Es válido para uso personal, pero no compartas el link públicamente mientras tu clave esté cargada en ese navegador — cualquiera que inspeccione las peticiones de red podría verla. Para un uso más seguro a futuro, se puede mover la llamada a un backend (hay código preparado para Supabase en `app.js`).
