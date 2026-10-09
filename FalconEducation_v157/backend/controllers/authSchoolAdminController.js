import db from "../config/db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/jwt.js";

// LOGIN SCHOOL ADMIN
export const schoolAdminLogin = (req, res) => {
  const { code, password } = req.body;

  if (!code || !password) {
    return res.status(400).json({ message: "Código e senha são obrigatórios" });
  }

  console.log(`[school-admin-login] Tentativa de login com código/email: "${code}"`);

  const sql = `
    SELECT sa.*, s.name as school_name, s.status as school_status
    FROM school_admins sa
    LEFT JOIN schools s ON sa.school_id = s.id
    WHERE sa.code = ? OR sa.email = ?
    LIMIT 1
  `;

  db.query(sql, [code, code], async (err, results) => {
    if (err) {
      console.error("[LOGIN ERROR]", err);
      return res.status(500).json({ message: "Erro no servidor" });
    }

    if (results.length === 0) {
      console.log(`[school-admin-login] Nenhum admin encontrado para "${code}"`);
      return res.status(401).json({ message: "Código ou senha inválidos" });
    }

    const admin = results[0];

    try {
      const isPasswordValid = await bcrypt.compare(password, admin.password);

      if (!isPasswordValid) {
        console.log(`[school-admin-login] Admin ${admin.code} (id=${admin.id}) encontrado, mas a senha não bateu.`);
        return res.status(401).json({ message: "Código ou senha inválidos" });
      }

      // Conta desativada pelo super admin
      if (admin.status === "inativo") {
        console.log(`[school-admin-login] Admin ${admin.code} (id=${admin.id}) está inativo.`);
        return res.status(401).json({ message: "Conta inativa. Contacte o super admin." });
      }

      // Escola com pagamento em atraso / desativada
      if (admin.school_status === "inativa") {
        console.log(`[school-admin-login] Escola do admin ${admin.code} está inativa.`);
        return res.status(401).json({ message: "Escola inativa. Verifique o pagamento." });
      }

      console.log(`[school-admin-login] Login OK para ${admin.code} (id=${admin.id}).`);

      // login OK - Gerar JWT token
      const token = jwt.sign(
        {
          id: admin.id,
          code: admin.code,
          school_id: admin.school_id,
          role: "schooladmin",
          // v120 — mesmo princípio já aplicado ao token do professor (v80):
          // sem o nome embutido, qualquer registo de auditoria feito pelo
          // admin da escola (req.user?.nome) ficava sempre undefined, tendo
          // de se voltar a consultar a base de dados só para saber quem fez
          // a ação. O código já vinha no token; passa a vir o nome também.
          nome: admin.name,
        },
        JWT_SECRET,
        { expiresIn: "24h" }
      );

      return res.json({
        token,
        user: {
          id: admin.id,
          code: admin.code,
          name: admin.name,
          email: admin.email,
          school_id: admin.school_id,
          school_name: admin.school_name,
          status: admin.status
        }
      });

    } catch (error) {
      console.error("[BCRYPT ERROR]", error);
      return res.status(500).json({ message: "Erro ao validar senha" });
    }
  });
};