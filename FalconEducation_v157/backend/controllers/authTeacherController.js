import db from '../config/db.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/jwt.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN DA ÁREA DO PROFESSOR — v80
// ─────────────────────────────────────────────────────────────────────────────
// Mesmo padrão do login do admin da escola (authSchoolAdminController.js):
// código + senha, bcrypt, JWT com validade de 24h. O `codigo_professor` é
// gerado automaticamente pelo sistema no cadastro (nunca digitado pelo admin
// — ver teacherController.js#createTeacher) e é globalmente único (contém o
// ID da escola + o ID do professor), por isso serve com segurança como
// identificador de login, tal como o `code` do admin da escola.
// ═══════════════════════════════════════════════════════════════════════════════
export const teacherLogin = async (req, res) => {
  try {
    const { codigo, password } = req.body;

    if (!codigo || !password) {
      return res.status(400).json({ success: false, message: 'Código e senha são obrigatórios' });
    }

    const rows = await queryAsync(
      `
        SELECT t.id, t.school_id, t.nome, t.email, t.codigo_professor, t.password, t.ativo,
               s.name as school_name, s.status as school_status
        FROM teachers t
        LEFT JOIN schools s ON s.id = t.school_id
        WHERE t.codigo_professor = ?
        LIMIT 1
      `,
      [codigo.trim()]
    );

    if (rows.length === 0) {
      console.log(`[teacher-login] Nenhum professor encontrado para o código "${codigo}"`);
      return res.status(401).json({ success: false, message: 'Código ou senha inválidos' });
    }

    const professor = rows[0];

    if (!professor.password) {
      // Professores antigos criados antes de existir palavra-passe na tabela
      // (não deveria acontecer em instalações novas, mas fica coberto).
      return res.status(401).json({ success: false, message: 'Esta conta ainda não tem palavra-passe definida. Contacte a direção da escola.' });
    }

    const senhaValida = await bcrypt.compare(password, professor.password);
    if (!senhaValida) {
      console.log(`[teacher-login] Professor ${professor.codigo_professor} (id=${professor.id}) encontrado, mas a senha não bateu.`);
      return res.status(401).json({ success: false, message: 'Código ou senha inválidos' });
    }

    if (!professor.ativo) {
      return res.status(401).json({ success: false, message: 'Conta inativa. Contacte a direção da escola.' });
    }
    if (professor.school_status === 'inativa') {
      return res.status(401).json({ success: false, message: 'Escola inativa. Contacte a administração.' });
    }

    const token = jwt.sign(
      {
        id: professor.id,
        codigo: professor.codigo_professor,
        school_id: professor.school_id,
        role: 'teacher',
        // v80 — ao contrário do JWT do admin (que só tem id/code/school_id/
        // role), aqui já incluímos o nome desde o início. Evita o mesmo bug
        // que existia em 6 sítios diferentes do sistema (req.user?.nome
        // sempre undefined porque o nome nunca vinha no token) — ver
        // CHANGELOG anterior sobre atribuição de autoria.
        nome: professor.nome,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log(`[teacher-login] Login OK para ${professor.codigo_professor} (id=${professor.id}).`);

    return res.json({
      success: true,
      token,
      professor: {
        id: professor.id,
        codigo: professor.codigo_professor,
        nome: professor.nome,
        email: professor.email,
        school_id: professor.school_id,
        school_name: professor.school_name,
      },
    });
  } catch (err) {
    console.error('[teacher-login] Erro no login do professor:', err);
    return res.status(500).json({ success: false, message: 'Erro no servidor' });
  }
};
