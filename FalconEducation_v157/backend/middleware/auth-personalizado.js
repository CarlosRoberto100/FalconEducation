import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/jwt.js";

// ⚠️ Este ficheiro não está montado em nenhuma rota ativa (ver app.js) — foi
// mantido por retrocompatibilidade, mas corrigido para não usar um segredo
// fixo, caso volte a ser importado no futuro.
const SECRET_KEY = JWT_SECRET;

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE 1: Verificar Token JWT
// ═══════════════════════════════════════════════════════════════════════════════
export const verificarToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log("[v0] Sem token no header Authorization");
    return res.status(401).json({ message: "Token não fornecido", error: "UNAUTHORIZED" });
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
    req.user.id = decoded.id || decoded.adminId;
    req.user.school_id = decoded.school_id;
    console.log(`[v0] Token verificado - Admin ID: ${req.user.id}, School ID: ${req.user.school_id}`);
    next();
  } catch (error) {
    console.log("[v0] Token inválido ou expirado:", error.message);
    return res.status(401).json({ message: "Token inválido ou expirado", error: "INVALID_TOKEN" });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE 2: Validar schoolId nos params
// ═══════════════════════════════════════════════════════════════════════════════
export const verificarSchoolId = (req, res, next) => {
  const { schoolId } = req.params;

  if (!schoolId) {
    console.log("[v0] schoolId ausente nos parametros");
    return res.status(400).json({ message: "schoolId é obrigatório" });
  }

  if (isNaN(schoolId)) {
    console.log("[v0] schoolId não é numérico:", schoolId);
    return res.status(400).json({ message: "schoolId deve ser numérico" });
  }

  // Verificar se o admin tem acesso a esta escola
  const userSchoolId = parseInt(req.user?.school_id);
  const paramSchoolId = parseInt(schoolId);

  if (userSchoolId !== paramSchoolId) {
    console.log(`[v0] Acesso negado - Admin ${req.user?.id} (school ${userSchoolId}) tentou acessar school ${paramSchoolId}`);
    return res.status(403).json({ message: "Acesso negado a esta escola" });
  }

  console.log(`[v0] Validado - School ID: ${schoolId}, Admin School: ${userSchoolId}`);
  next();
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Gerar Token JWT (usar no login)
// ═══════════════════════════════════════════════════════════════════════════════
export const gerarToken = (admin) => {
  return jwt.sign(
    {
      id: admin.id,
      adminId: admin.id,
      school_id: admin.school_id,
      code: admin.code,
      email: admin.email,
      name: admin.name
    },
    SECRET_KEY,
    { expiresIn: "7d" }
  );
};