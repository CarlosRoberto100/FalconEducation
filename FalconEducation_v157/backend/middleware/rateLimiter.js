import rateLimit from "express-rate-limit";

/**
 * ═══════════════════════════════════════════════════════════════
 * RATE LIMITER PARA ROTAS DE LOGIN
 * Protege contra ataques de força bruta (tentativas repetidas de
 * adivinhar código/senha). Limita por IP.
 * ═══════════════════════════════════════════════════════════════
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // 10 tentativas por IP a cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Demasiadas tentativas de login. Tente novamente dentro de 15 minutos.",
  },
  handler: (req, res, next, options) => {
    console.warn(`[SECURITY] Rate limit de login atingido para IP: ${req.ip}`);
    res.status(429).json(options.message);
  },
});

/**
 * ═══════════════════════════════════════════════════════════════
 * RATE LIMITER PARA AÇÕES SENSÍVEIS (v59)
 * Reset de senha de admin, criação/remoção de admins e escolas —
 * operações de plataforma que já exigem super admin, mas que continuam
 * a merecer um limite à parte: um token comprometido não devia conseguir
 * automatizar centenas de resets/criações por minuto.
 * ═══════════════════════════════════════════════════════════════
 */
export const sensitiveActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // 20 ações sensíveis por IP a cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Demasiadas ações sensíveis seguidas. Tente novamente dentro de 15 minutos.",
  },
  handler: (req, res, next, options) => {
    console.warn(`[SECURITY] Rate limit de ação sensível atingido para IP: ${req.ip}`);
    res.status(429).json(options.message);
  },
});

/**
 * ═══════════════════════════════════════════════════════════════
 * RATE LIMITER GERAL DA API (v59)
 * Baseline generoso contra abuso/DoS simples — não deve incomodar o uso
 * normal do dashboard (várias chamadas em paralelo ao trocar de aba),
 * só corta picos claramente anómalos vindos do mesmo IP.
 * ═══════════════════════════════════════════════════════════════
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 300, // 300 pedidos por IP por minuto
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Demasiados pedidos. Aguarde um momento e tente novamente.",
  },
  handler: (req, res, next, options) => {
    console.warn(`[SECURITY] Rate limit geral da API atingido para IP: ${req.ip}`);
    res.status(429).json(options.message);
  },
});
