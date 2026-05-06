const { COOKIE_NAME, verify } = require("./jwt");

// Attach req.user if a valid session cookie is present, otherwise leave it
// null. Never throws — anonymous requests fall through transparently.
function attachUser(req, _res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next();
  const claims = verify(token);
  if (claims && claims.sub && claims.email) {
    req.user = { id: claims.sub, email: claims.email };
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "auth_required" });
  }
  next();
}

module.exports = { attachUser, requireUser };
