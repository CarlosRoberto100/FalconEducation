import db from "../config/db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/jwt.js";

export const loginSuperAdmin = (req, res) => {
  const { code, password } = req.body;

  if (!code || !password) {
    return res.status(400).json({ message: "Preencha todos os campos" });
  }

  db.query(
    "SELECT * FROM super_admins WHERE code = ?",
    [code],
    async (err, results) => {
      if (err) {
        return res.status(500).json({ message: "Erro no servidor" });
      }

      if (results.length === 0) {
        // Mensagem genérica de propósito: não revelar se o código existe ou
        // não, para não facilitar a um atacante descobrir códigos válidos.
        return res.status(401).json({ message: "Código ou senha inválidos" });
      }

      const user = results[0];

      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return res.status(401).json({ message: "Código ou senha inválidos" });
      }

      // Emite um token JWT (antes o login não gerava nenhum — as rotas do
      // super admin ficavam sem forma de verificar quem estava autenticado).
      const token = jwt.sign(
        { id: user.id, code: user.code, role: "superadmin" },
        JWT_SECRET,
        { expiresIn: "24h" }
      );

      res.json({
        message: "Login bem-sucedido 🚀",
        token,
        userId: user.id,
        code: user.code,
      });
    }
  );
};