const express = require("express");
const qrcode = require("qrcode");
const axios = require("axios");
const {
  Client,
  LocalAuth,
  MessageMedia
} = require("whatsapp-web.js");

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

// ======================================================
// CONFIGURACIÓN
// ======================================================

const LOVABLE_URL =
  process.env.LOVABLE_URL ||
  "https://project--72690319-9033-432e-826e-0cd4d4445254.lovable.app";

const BOT_API_KEY = process.env.BOT_DOS_GRUPOS_API_KEY;

if (!BOT_API_KEY) {
  console.error("❌ Falta BOT_DOS_GRUPOS_API_KEY");
  process.exit(1);
}

const API = `${LOVABLE_URL}/api/public/dos-grupos`;

let ultimoQR = null;
let whatsappListo = false;

let config = {
  grupo_clientes_id: null,
  grupo_clientes_nombre: null,

  grupo_peticiones_id: null,
  grupo_peticiones_nombre: null,

  activo: false
};

// Evita procesar dos veces el mismo mensaje
const procesados = new Map();

function yaProcesado(id) {
  if (!id) return false;

  if (procesados.has(id)) {
    return true;
  }

  procesados.set(id, Date.now());

  // Limpiar registros viejos
  if (procesados.size > 5000) {
    const limite = Date.now() - 6 * 60 * 60 * 1000;

    for (const [key, fecha] of procesados.entries()) {
      if (fecha < limite) {
        procesados.delete(key);
      }
    }
  }

  return false;
}

// ======================================================
// AXIOS LOVABLE
// ======================================================

const lovable = axios.create({
  baseURL: API,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${BOT_API_KEY}`,
    "Content-Type": "application/json"
  }
});

function mensajeError(error) {
  if (error.response) {
    return `HTTP ${error.response.status}: ${JSON.stringify(
      error.response.data
    )}`;
  }

  return error.message;
}

// ======================================================
// WHATSAPP
// ======================================================

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "bot-dos-grupos",
    dataPath: "/data/.wwebjs_auth"
  }),

  puppeteer: {
    headless: true,

    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      "/usr/bin/google-chrome-stable",

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote"
    ]
  }
});

// ======================================================
// QR
// ======================================================

client.on("qr", async qr => {
  console.log("====================================");
  console.log("NUEVO QR GENERADO");
  console.log("====================================");

  try {
    ultimoQR = await qrcode.toDataURL(qr);
  } catch (error) {
    console.error("Error generando QR:", error.message);
  }
});

client.on("authenticated", () => {
  console.log("✅ WhatsApp autenticado correctamente");
});

client.on("auth_failure", msg => {
  whatsappListo = false;
  console.error("❌ Falló autenticación:", msg);
});

client.on("disconnected", reason => {
  whatsappListo = false;
  console.log("⚠️ WhatsApp desconectado:", reason);
});

// ======================================================
// CARGAR CONFIGURACIÓN DE LOVABLE
// ======================================================

async function cargarConfiguracion() {
  try {
    const response = await lovable.get("/config");

    const data = response.data || {};

    config = {
      grupo_clientes_id:
        data.grupo_clientes_id ||
        data.config?.grupo_clientes_id ||
        null,

      grupo_clientes_nombre:
        data.grupo_clientes_nombre ||
        data.config?.grupo_clientes_nombre ||
        null,

      grupo_peticiones_id:
        data.grupo_peticiones_id ||
        data.config?.grupo_peticiones_id ||
        null,

      grupo_peticiones_nombre:
        data.grupo_peticiones_nombre ||
        data.config?.grupo_peticiones_nombre ||
        null,

      activo:
        data.activo ??
        data.config?.activo ??
        false
    };

    console.log("====================================");
    console.log("CONFIGURACIÓN");
    console.log("Clientes:", config.grupo_clientes_nombre);
    console.log("ID:", config.grupo_clientes_id);
    console.log("Proveedor:", config.grupo_peticiones_nombre);
    console.log("ID:", config.grupo_peticiones_id);
    console.log("Activo:", config.activo);
    console.log("====================================");
  } catch (error) {
    console.error(
      "⚠️ No se pudo cargar configuración:",
      mensajeError(error)
    );
  }
}

// ======================================================
// SINCRONIZAR GRUPOS CON LOVABLE
// ======================================================

async function sincronizarGrupos() {
  if (!whatsappListo) return;

  try {
    const chats = await client.getChats();

    const grupos = chats
      .filter(chat => chat.isGroup)
      .map(chat => ({
        id: chat.id._serialized,
        nombre: chat.name || "Grupo sin nombre"
      }));

    console.log(`📋 ${grupos.length} grupos encontrados`);

    // Probamos formato por lote.
    try {
      await lovable.post("/grupos", {
        grupos
      });

      console.log("✅ Grupos enviados a Lovable");
    } catch (error) {
      // Si Lovable espera un grupo por llamada,
      // intentamos individualmente.
      console.log(
        "⚠️ Envío por lote no aceptado. Probando individual..."
      );

      for (const grupo of grupos) {
        try {
          await lovable.post("/grupos", grupo);
        } catch (e) {
          console.error(
            `Error guardando grupo ${grupo.nombre}:`,
            mensajeError(e)
          );
        }
      }
    }
  } catch (error) {
    console.error(
      "❌ Error obteniendo grupos:",
      error.message
    );
  }
}

// ======================================================
// READY
// ======================================================

client.on("ready", async () => {
  whatsappListo = true;
  ultimoQR = null;

  console.log("");
  console.log("====================================");
  console.log("✅ WHATSAPP LISTO");
  console.log("====================================");

  await cargarConfiguracion();
  await sincronizarGrupos();

  // Actualizar configuración periódicamente
  setInterval(cargarConfiguracion, 30000);

  // Refrescar grupos cada 5 minutos
  setInterval(sincronizarGrupos, 5 * 60 * 1000);
});

// ======================================================
// UTILIDADES
// ======================================================

function normalizarId(id) {
  if (!id) return "";
  return String(id).trim();
}

function esGrupoClientes(chatId) {
  return (
    normalizarId(chatId) ===
    normalizarId(config.grupo_clientes_id)
  );
}

function esGrupoProveedor(chatId) {
  return (
    normalizarId(chatId) ===
    normalizarId(config.grupo_peticiones_id)
  );
}

async function obtenerNombreRemitente(message) {
  try {
    const contact = await message.getContact();

    return (
      contact.pushname ||
      contact.name ||
      contact.number ||
      "Cliente"
    );
  } catch {
    return "Cliente";
  }
}

async function obtenerTelefono(message) {
  try {
    const contact = await message.getContact();

    return (
      contact.number ||
      message.author ||
      message.from ||
      ""
    );
  } catch {
    return message.author || "";
  }
}

async function obtenerQuotedId(message) {
  try {
    if (!message.hasQuotedMsg) {
      return null;
    }

    const quoted = await message.getQuotedMessage();

    return quoted?.id?._serialized || null;
  } catch {
    return null;
  }
}

// ======================================================
// CLIENTE → LOVABLE → PROVEEDOR
// ======================================================

async function procesarSolicitudCliente(message) {
  const texto = (message.body || "").trim();

  if (!texto) return;

  const nombre = await obtenerNombreRemitente(message);
  const telefono = await obtenerTelefono(message);

  console.log("");
  console.log("====================================");
  console.log("📥 SOLICITUD CLIENTE");
  console.log("Cliente:", nombre);
  console.log("Mensaje:", texto);
  console.log("====================================");

  try {
    const response = await lovable.post("/solicitudes", {
      mensaje: texto,

      chat_cliente_id: message.from,

      mensaje_cliente_id:
        message.id._serialized,

      cliente_nombre: nombre,

      cliente_telefono: telefono
    });

    const data = response.data;

    if (!data?.ok) {
      if (data?.codigo === "SOLICITUD_INVALIDA") {
        await message.reply(
          "❌ Solicitud incorrecta.\n\n" +
          "Envía una CURP válida de 18 caracteres o una cadena de exactamente 20 números."
        );
      }

      return;
    }

    const solicitud = data.solicitud;

    if (!solicitud) {
      console.log("⚠️ Lovable no devolvió solicitud");
      return;
    }

    // Si ya existe la misma consulta en curso,
    // NO volver a mandarla al proveedor.
    if (data.enviar_proveedor === false) {
      console.log(
        "♻️ Solicitud agregada como destinatario adicional"
      );

      await message.reply(
        "✅ Petición registrada. Ya se encuentra en proceso."
      );

      return;
    }

    if (!config.grupo_peticiones_id) {
      console.error(
        "❌ No está configurado el grupo proveedor"
      );

      await message.reply(
        "⚠️ La petición fue registrada, pero el grupo de peticiones todavía no está configurado."
      );

      return;
    }

    const textoProveedor =
      solicitud.texto_proveedor || texto;

    const enviado = await client.sendMessage(
      config.grupo_peticiones_id,
      textoProveedor
    );

    console.log(
      "📤 Petición enviada al proveedor:",
      textoProveedor
    );

    await lovable.post(
      `/solicitudes/${solicitud.id}/enviada`,
      {
        chat_proveedor_id:
          config.grupo_peticiones_id,

        mensaje_proveedor_id:
          enviado.id._serialized
      }
    );

    await message.reply(
      "✅ Petición enviada."
    );

  } catch (error) {
    console.error(
      "❌ Error procesando solicitud:",
      mensajeError(error)
    );

    if (error.response?.status === 400) {
      try {
        await message.reply(
          "❌ Solicitud incorrecta.\n\n" +
          "Revisa la CURP o cadena e inténtalo nuevamente."
        );
      } catch {}
    }
  }
}

// ======================================================
// RESPUESTA TEXTO PROVEEDOR
// ======================================================

async function procesarRespuestaProveedor(message) {
  const texto = (message.body || "").trim();

  if (!texto) return;

  // Estos mensajes informativos no interesan.
  if (
    /pdf enviado exitosamente/i.test(texto)
  ) {
    return;
  }

  const quotedId =
    await obtenerQuotedId(message);

  console.log("");
  console.log("====================================");
  console.log("📨 RESPUESTA PROVEEDOR");
  console.log(texto);
  console.log("====================================");

  try {
    const response = await lovable.post(
      "/respuesta",
      {
        chat_proveedor_id:
          message.from,

        mensaje_id:
          message.id._serialized,

        texto,

        quoted_mensaje_id:
          quotedId
      }
    );

    const data = response.data;

    if (!data?.ok) {
      return;
    }

    if (
      data.tipo !== "no_encontrada" ||
      !Array.isArray(data.resultados)
    ) {
      return;
    }

    for (const resultado of data.resultados) {
      const destinatarios =
        resultado.destinatarios || [];

      for (const destinatario of destinatarios) {
        if (!destinatario.chat_cliente_id) {
          continue;
        }

        let identificador =
          resultado.curp ||
          resultado.cadena ||
          "Solicitud";

        let acto =
          resultado.acto
            ? `\n${resultado.acto}`
            : "";

        const respuestaCliente =
          `❌ No se encontró información.\n\n` +
          `${identificador}${acto}`;

        try {
          await client.sendMessage(
            destinatario.chat_cliente_id,
            respuestaCliente
          );

          console.log(
            "📤 No encontrada enviada a:",
            destinatario.cliente_nombre
          );

          // No llamamos /entregada porque
          // no hubo PDF. Lovable ya mantiene
          // estado no_encontrada.
        } catch (error) {
          console.error(
            "Error enviando resultado al cliente:",
            error.message
          );
        }
      }
    }
  } catch (error) {
    console.error(
      "❌ Error procesando respuesta:",
      mensajeError(error)
    );
  }
}

// ======================================================
// PDF PROVEEDOR → LOVABLE → CLIENTES
// ======================================================

async function procesarPdfProveedor(message) {
  console.log("");
  console.log("====================================");
  console.log("📄 PDF RECIBIDO DEL PROVEEDOR");
  console.log("====================================");

  try {
    const media =
      await message.downloadMedia();

    if (!media) {
      console.log(
        "❌ No se pudo descargar el archivo"
      );
      return;
    }

    const mime =
      String(media.mimetype || "").toLowerCase();

    if (
      mime !== "application/pdf" &&
      !mime.includes("pdf")
    ) {
      console.log(
        "⏭️ Archivo ignorado: no es PDF"
      );
      return;
    }

    const nombreArchivo =
      message._data?.filename ||
      media.filename ||
      "documento.pdf";

    const quotedId =
      await obtenerQuotedId(message);

    const caption =
      (message.body || "").trim();

    console.log(
      "Archivo:",
      nombreArchivo
    );

    const response =
      await lovable.post("/pdf", {
        chat_proveedor_id:
          message.from,

        mensaje_id:
          message.id._serialized,

        nombre_archivo:
          nombreArchivo,

        archivo_base64:
          media.data,

        caption,

        quoted_mensaje_id:
          quotedId
      });

    const data = response.data;

    if (!data?.ok) {
      console.log(
        "⚠️ Lovable no pudo relacionar PDF:",
        data
      );

      return;
    }

    const destinatarios =
      data.destinatarios || [];

    if (destinatarios.length === 0) {
      console.log(
        "⚠️ PDF sin destinatarios"
      );

      return;
    }

    // Utilizamos exactamente el mismo PDF recibido.
    const pdfParaEnviar =
      new MessageMedia(
        "application/pdf",
        media.data,
        data.pdf_nombre ||
          nombreArchivo
      );

    for (const destinatario of destinatarios) {
      if (!destinatario.chat_cliente_id) {
        continue;
      }

      try {
        const captionCliente =
          "✅ Documento listo.";

        await client.sendMessage(
          destinatario.chat_cliente_id,
          pdfParaEnviar,
          {
            caption: captionCliente
          }
        );

        console.log(
          `✅ PDF entregado a ${destinatario.cliente_nombre || "cliente"}`
        );

        await lovable.post(
          `/solicitudes/${destinatario.solicitud_id}/entregada`,
          {}
        );

      } catch (error) {
        console.error(
          `❌ No se pudo entregar PDF a ${destinatario.cliente_nombre || "cliente"}:`,
          error.message
        );
      }
    }

  } catch (error) {
    if (
      error.response?.data?.codigo ===
      "REQUIERE_REVISION"
    ) {
      console.log(
        "⚠️ PDF requiere revisión manual"
      );

      console.log(
        error.response.data.motivo
      );

      return;
    }

    if (
      error.response?.status === 404
    ) {
      console.log(
        "⚠️ PDF recibido pero no existe solicitud pendiente relacionada"
      );

      return;
    }

    console.error(
      "❌ Error procesando PDF:",
      mensajeError(error)
    );
  }
}

// ======================================================
// MENSAJES
// ======================================================

client.on("message", async message => {
  try {
    if (!whatsappListo) return;

    // Nunca procesar nuestros propios mensajes
    if (message.fromMe) return;

    const messageId =
      message.id?._serialized;

    if (yaProcesado(messageId)) {
      return;
    }

    const chatId =
      message.from;

    // ------------------------------
    // GRUPO CLIENTES
    // ------------------------------

    if (esGrupoClientes(chatId)) {
      // Solo solicitudes de texto
      if (!message.hasMedia) {
        await procesarSolicitudCliente(
          message
        );
      }

      return;
    }

    // ------------------------------
    // GRUPO PROVEEDOR
    // ------------------------------

    if (esGrupoProveedor(chatId)) {
      if (message.hasMedia) {
        await procesarPdfProveedor(
          message
        );

        return;
      }

      await procesarRespuestaProveedor(
        message
      );
    }

  } catch (error) {
    console.error(
      "❌ Error general message:",
      error
    );
  }
});

// ======================================================
// ENDPOINTS WEB
// ======================================================

app.get("/", (req, res) => {
  res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Bot Dos Grupos</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 700px;
            margin: 40px auto;
            padding: 20px;
          }
          img {
            max-width: 350px;
          }
          .ok {
            color: green;
          }
          .wait {
            color: orange;
          }
        </style>
      </head>

      <body>
        <h1>Bot WhatsApp — Dos Grupos</h1>

        ${
          whatsappListo
            ? `
              <h2 class="ok">
                ✅ WhatsApp conectado
              </h2>

              <p>
                Grupo clientes:
                <b>
                  ${config.grupo_clientes_nombre || "No configurado"}
                </b>
              </p>

              <p>
                Grupo proveedor:
                <b>
                  ${config.grupo_peticiones_nombre || "No configurado"}
                </b>
              </p>

              <p>
                Bot activo:
                <b>
                  ${config.activo ? "Sí" : "No"}
                </b>
              </p>
            `
            : ultimoQR
            ? `
              <h2 class="wait">
                Escanea el QR
              </h2>

              <img src="${ultimoQR}">
            `
            : `
              <h2 class="wait">
                Esperando WhatsApp...
              </h2>

              <p>
                Actualiza esta página en unos segundos.
              </p>
            `
        }
      </body>
    </html>
  `);
});

app.get("/estado", (req, res) => {
  res.json({
    ok: true,

    whatsapp: whatsappListo,

    qr_disponible:
      Boolean(ultimoQR),

    config
  });
});

app.get("/grupos", async (req, res) => {
  if (!whatsappListo) {
    return res.status(503).json({
      ok: false,
      error: "WhatsApp no conectado"
    });
  }

  try {
    const chats =
      await client.getChats();

    const grupos = chats
      .filter(chat => chat.isGroup)
      .map(chat => ({
        id: chat.id._serialized,
        nombre: chat.name
      }));

    res.json({
      ok: true,
      grupos
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/refrescar-config", async (req, res) => {
  await cargarConfiguracion();

  res.json({
    ok: true,
    config
  });
});

// ======================================================
// SERVIDOR
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("====================================");
  console.log(
    `🌐 Servidor activo en puerto ${PORT}`
  );
  console.log("====================================");
});

// ======================================================
// INICIAR WHATSAPP
// ======================================================

console.log("🚀 Iniciando WhatsApp...");

client.initialize().catch(error => {
  console.error(
    "❌ Error inicializando WhatsApp:",
    error
  );
});

// ======================================================
// ERRORES GLOBALES
// ======================================================

process.on(
  "unhandledRejection",
  reason => {
    console.error(
      "Unhandled Rejection:",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught Exception:",
      error
    );
  }
);
