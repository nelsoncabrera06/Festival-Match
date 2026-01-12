const { OAuth2Client } = require('google-auth-library');
const { findOrCreateUser, createSession, getSession, deleteSession } = require('./db');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3002/auth/google/callback';

const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

// Scopes necesarios
const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// Generar URL de autorizacion
function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

// Intercambiar codigo por tokens y obtener info del usuario
async function handleCallback(code) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Obtener info del usuario
  const ticket = await oauth2Client.verifyIdToken({
    idToken: tokens.id_token,
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  // Crear o actualizar usuario en la base de datos
  const user = await findOrCreateUser(payload);

  // Crear sesion
  const sessionId = await createSession(user.id);

  return { user, sessionId };
}

// Middleware para verificar sesion (async)
async function requireAuth(req, res, next) {
  const sessionId = req.cookies?.session || req.headers['x-session-id'];

  if (!sessionId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const session = await getSession(sessionId);

  if (!session) {
    return res.status(401).json({ error: 'Sesion invalida o expirada' });
  }

  // Adjuntar usuario al request
  req.user = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    picture: session.picture,
  };
  req.sessionId = sessionId;

  next();
}

// Middleware opcional - no falla si no hay sesion (async)
async function optionalAuth(req, res, next) {
  const sessionId = req.cookies?.session || req.headers['x-session-id'];

  if (sessionId) {
    const session = await getSession(sessionId);
    if (session) {
      req.user = {
        id: session.user_id,
        email: session.email,
        name: session.name,
        picture: session.picture,
      };
      req.sessionId = sessionId;
    }
  }

  next();
}

// Cerrar sesion
async function logout(sessionId) {
  if (sessionId) {
    await deleteSession(sessionId);
  }
}

module.exports = {
  getAuthUrl,
  handleCallback,
  requireAuth,
  optionalAuth,
  logout,
};
