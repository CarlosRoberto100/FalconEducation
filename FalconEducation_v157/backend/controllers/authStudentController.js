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
// LOGIN DA ÁREA DO ALUNO — v82
// ─────────────────────────────────────────────────────────────────────────────
// Mesmo padrão do login do professor (authTeacherController.js) e do admin da
// escola: código + senha, bcrypt, JWT de 24h. O `codigo_aluno` é gerado
// automaticamente pelo sistema no cadastro (nunca digitado pelo admin — ver
// studentController.js#createStudent) e verificado como único antes de ser
// aceite, por isso serve com segurança como identificador de login.
// ═══════════════════════════════════════════════════════════════════════════════
export const studentLogin = async (req, res) => {
  try {
    const { codigo, password } = req.body;

    if (!codigo || !password) {
      return res.status(400).json({ success: false, message: 'Código e senha são obrigatórios' });
    }

    const rows = await queryAsync(
      `
        SELECT s.id, s.school_id, s.nome, s.email, s.codigo_aluno, s.password, s.ativo, s.turma_id,
               t.nome as turma_nome, c.nome as classe_nome,
               sc.name as school_name, sc.status as school_status
        FROM students s
        LEFT JOIN turmas t ON t.id = s.turma_id
        LEFT JOIN classes c ON c.id = t.class_id
        LEFT JOIN schools sc ON sc.id = s.school_id
        WHERE s.codigo_aluno = ?
        LIMIT 1
      `,
      [codigo.trim()]
    );

    if (rows.length === 0) {
      console.log(`[student-login] Nenhum aluno encontrado para o código "${codigo}"`);
      return res.status(401).json({ success: false, message: 'Código ou senha inválidos' });
    }

    const aluno = rows[0];

    if (!aluno.password) {
      return res.status(401).json({ success: false, message: 'Esta conta ainda não tem palavra-passe definida. Contacte a secretaria da escola.' });
    }

    const senhaValida = await bcrypt.compare(password, aluno.password);
    if (!senhaValida) {
      console.log(`[student-login] Aluno ${aluno.codigo_aluno} (id=${aluno.id}) encontrado, mas a senha não bateu.`);
      return res.status(401).json({ success: false, message: 'Código ou senha inválidos' });
    }

    if (!aluno.ativo) {
      return res.status(401).json({ success: false, message: 'Matrícula inativa. Contacte a secretaria da escola.' });
    }
    if (aluno.school_status === 'inativa') {
      return res.status(401).json({ success: false, message: 'Escola inativa. Contacte a administração.' });
    }

    const token = jwt.sign(
      {
        id: aluno.id,
        codigo: aluno.codigo_aluno,
        school_id: aluno.school_id,
        role: 'student',
        // v82 — nome já incluído desde o início no token, evitando o mesmo
        // bug de atribuição (req.user?.nome sempre undefined) corrigido em
        // várias partes do sistema numa versão anterior.
        nome: aluno.nome,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log(`[student-login] Login OK para ${aluno.codigo_aluno} (id=${aluno.id}).`);

    return res.json({
      success: true,
      token,
      aluno: {
        id: aluno.id,
        codigo: aluno.codigo_aluno,
        nome: aluno.nome,
        email: aluno.email,
        school_id: aluno.school_id,
        school_name: aluno.school_name,
        turma_nome: aluno.turma_nome,
        classe_nome: aluno.classe_nome,
      },
    });
  } catch (err) {
    console.error('[student-login] Erro no login do aluno:', err);
    return res.status(500).json({ success: false, message: 'Erro no servidor' });
  }
};
