import db from '../config/db.js';
import bcrypt from 'bcrypt';
import { criarNotificacao } from './notificationController.js';
import { ensureTeachersColunasAdministrativas, TIPOS_CONTRATO_VALIDOS } from './teacherAdminController.js';
import { gerarDespesasSalariosDoMes } from './dashboardController.js';
import { registrarAuditoria } from '../services/auditService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const gerarCodigoProfessor = (teacherId, schoolId) => {
  const hoje = new Date();
  const dia = String(hoje.getDate()).padStart(2, '0');
  const ano = String(hoje.getFullYear());
  return `PROF${schoolId}${teacherId}${dia}${ano}`;
};

// v80 — código do professor SEMPRE gerado pelo sistema, nunca digitado pelo
// admin (ver createTeacher: o campo `codigo` deixou de ser lido do corpo do
// pedido). O `teacherId` é a chave primária AUTO_INCREMENT da tabela
// `teachers`, por isso já é matematicamente impossível dois professores
// receberem o mesmo valor — mesmo assim, confirmamos aqui por segurança
// extra (o custo de mais um SELECT é insignificante, isto só corre uma vez
// por professor, no cadastro) e caímos num sufixo numérico no caso
// impossível de colisão, para NUNCA devolver um código já usado.
const gerarCodigoProfessorUnico = async (schoolId, teacherId) => {
  let candidato = gerarCodigoProfessor(teacherId, schoolId);
  let tentativa = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existente = await queryAsync(`SELECT id FROM teachers WHERE codigo_professor = ? AND id != ? LIMIT 1`, [candidato, teacherId]);
    if (existente.length === 0) return candidato;
    tentativa += 1;
    candidato = `${gerarCodigoProfessor(teacherId, schoolId)}-${tentativa}`;
  }
};

// Garante que cada nome de disciplina exista na tabela `disciplinas` da escola
// e retorna a lista de IDs correspondentes (cria a disciplina se ainda não existir)
const getOrCreateDisciplinaIds = async (schoolId, nomesDisciplinas = []) => {
  const ids = [];

  for (const nomeOriginal of nomesDisciplinas) {
    const nome = String(nomeOriginal || '').trim();
    if (!nome) continue;

    const existentes = await queryAsync(
      `SELECT id FROM disciplinas WHERE school_id = ? AND nome = ? LIMIT 1`,
      [schoolId, nome]
    );

    if (existentes.length > 0) {
      ids.push(existentes[0].id);
      continue;
    }

    const inserida = await queryAsync(
      `INSERT INTO disciplinas (school_id, nome, ativa, created_at, updated_at) VALUES (?, ?, TRUE, NOW(), NOW())`,
      [schoolId, nome]
    );
    ids.push(inserida.insertId);
  }

  return ids;
};

const setTeacherDisciplinas = async (teacherId, disciplinaIds = []) => {
  await queryAsync(`DELETE FROM teacher_disciplines WHERE teacher_id = ?`, [teacherId]);

  for (const disciplinaId of disciplinaIds) {
    await queryAsync(
      `INSERT IGNORE INTO teacher_disciplines (teacher_id, disciplina_id, created_at) VALUES (?, ?, NOW())`,
      [teacherId, disciplinaId]
    );
  }
};

/**
 * GET: Listar todos os professores da escola (com disciplinas agregadas)
 */
export const getAllTeachers = async (req, res) => {
  try {
    const { schoolId } = req.params;

    await ensureTeachersColunasAdministrativas();

    const query = `
      SELECT
        t.id,
        t.school_id,
        t.nome,
        t.email,
        t.telefone,
        t.idade,
        t.genero,
        t.salario,
        t.numero_professor,
        t.codigo_professor,
        t.morada,
        t.documento,
        t.tipo_contrato,
        t.ativo,
        t.data_admissao,
        t.created_at,
        t.updated_at,
        GROUP_CONCAT(DISTINCT d.nome ORDER BY d.nome SEPARATOR ', ') as disciplinas
      FROM teachers t
      LEFT JOIN teacher_disciplines td ON td.teacher_id = t.id
      LEFT JOIN disciplinas d ON d.id = td.disciplina_id
      WHERE t.school_id = ?
      GROUP BY t.id
      ORDER BY t.nome ASC
    `;

    const results = await queryAsync(query, [schoolId]);

    const data = results.map((row) => ({
      ...row,
      disciplinas: row.disciplinas ? row.disciplinas.split(', ') : [],
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[v0] Erro ao listar professores:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ success: true, data: [] });
    }
    res.status(500).json({ success: false, message: 'Erro ao listar professores', error: err.message });
  }
};

/**
 * GET: Buscar um professor específico
 */
export const getTeacherById = async (req, res) => {
  try {
    const { schoolId, teacherId } = req.params;

    const results = await queryAsync(
      `
        SELECT
          t.*,
          GROUP_CONCAT(DISTINCT d.nome ORDER BY d.nome SEPARATOR ', ') as disciplinas
        FROM teachers t
        LEFT JOIN teacher_disciplines td ON td.teacher_id = t.id
        LEFT JOIN disciplinas d ON d.id = td.disciplina_id
        WHERE t.id = ? AND t.school_id = ?
        GROUP BY t.id
      `,
      [teacherId, schoolId]
    );

    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'Professor não encontrado' });
    }

    const professor = results[0];
    professor.disciplinas = professor.disciplinas ? professor.disciplinas.split(', ') : [];
    delete professor.password;

    res.json({ success: true, data: professor });
  } catch (err) {
    console.error('[v0] Erro ao buscar professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar professor', error: err.message });
  }
};

export const getTeacherCountBySchool = (req, res) => {
  const { schoolId } = req.params;

  const query = `SELECT COUNT(*) as total FROM teachers WHERE school_id = ? AND ativo = TRUE`;
  db.query(query, [schoolId], (err, results) => {
    if (err) {
      console.error('[v0] Erro ao contar professores:', err);
      if (err.code === 'ER_NO_SUCH_TABLE') {
        return res.json({ success: true, total: 0 });
      }
      return res.status(500).json({ success: false, message: 'Erro ao contar professores', error: err.message });
    }

    res.json({ success: true, total: results[0].total });
  });
};

/**
 * POST: Cadastrar novo professor
 */
export const createTeacher = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const {
      nome,
      idade,
      genero,
      salario,
      contacto,
      telefone,
      gmail,
      email,
      password,
      morada,
      documento,
      tipo_contrato,
      data_admissao,
      disciplinas = [],
    } = req.body;

    const emailFinal = email || gmail || null;
    const telefoneFinal = telefone || contacto || null;

    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ success: false, message: 'Nome do professor é obrigatório' });
    }

    if (!idade || isNaN(parseInt(idade, 10))) {
      return res.status(400).json({ success: false, message: 'Idade é obrigatória e deve ser um número válido' });
    }

    if (salario === undefined || salario === null || salario === '' || isNaN(parseFloat(salario))) {
      return res.status(400).json({ success: false, message: 'Salário é obrigatório e deve ser um número válido' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Senha é obrigatória e deve ter no mínimo 6 caracteres' });
    }

    if (!Array.isArray(disciplinas) || disciplinas.filter((d) => String(d).trim()).length === 0) {
      return res.status(400).json({ success: false, message: 'Selecione ao menos uma disciplina' });
    }

    if (tipo_contrato !== undefined && tipo_contrato !== null && tipo_contrato !== '' && !TIPOS_CONTRATO_VALIDOS.includes(tipo_contrato)) {
      return res.status(400).json({ success: false, message: `Tipo de contrato inválido. Use um de: ${TIPOS_CONTRATO_VALIDOS.join(', ')}` });
    }

    // Garante que tipo_contrato/estado_contrato/datas de contrato já existem na
    // tabela `teachers` antes de tentarmos gravá-los — mesma auto-migração
    // idempotente usada no resto do "Perfil Administrativo do Professor".
    await ensureTeachersColunasAdministrativas();

    if (emailFinal) {
      const emailExistente = await queryAsync(
        `SELECT id FROM teachers WHERE email = ? LIMIT 1`,
        [emailFinal]
      );
      if (emailExistente.length > 0) {
        return res.status(409).json({ success: false, message: 'Já existe um professor cadastrado com este email' });
      }
    }

    // v80 — o código do professor NUNCA é aceite do cliente (nem para criar,
    // nem para editar — updateTeacher também não permite alterá-lo). É
    // sempre o sistema a gerar, logo abaixo, depois de sabermos o
    // teacherId. Isto elimina de vez a possibilidade de dois professores
    // ficarem com o mesmo código por erro humano (o `codigoExistente` que
    // existia aqui antes só protegia contra duplicação quando o código era
    // digitado manualmente — já não se aplica).

    const hashedPassword = await bcrypt.hash(password, 10);

    const insertResult = await queryAsync(
      `
        INSERT INTO teachers
          (school_id, nome, email, telefone, idade, genero, salario, codigo_professor, password, morada, documento, tipo_contrato, ativo, data_admissao, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, TRUE, ?, NOW(), NOW())
      `,
      [
        schoolId,
        String(nome).trim(),
        emailFinal,
        telefoneFinal,
        parseInt(idade, 10),
        genero || null,
        parseFloat(salario),
        hashedPassword,
        morada || null,
        documento || null,
        tipo_contrato || null,
        data_admissao || new Date().toISOString().split('T')[0],
      ]
    );

    const teacherId = insertResult.insertId;

    const codigoGerado = await gerarCodigoProfessorUnico(schoolId, teacherId);
    await queryAsync(`UPDATE teachers SET codigo_professor = ? WHERE id = ?`, [codigoGerado, teacherId]);

    const disciplinaIds = await getOrCreateDisciplinaIds(schoolId, disciplinas);
    await setTeacherDisciplinas(teacherId, disciplinaIds);

    const [professorCriado] = await queryAsync(
      `SELECT id, nome, email, telefone, idade, genero, salario, codigo_professor, morada, documento, tipo_contrato, data_admissao, ativo FROM teachers WHERE id = ?`,
      [teacherId]
    );

    await criarNotificacao(schoolId, 'novo_professor', 'Novo professor registado', `${professorCriado.nome} foi registado(a) como professor(a).`);

    // v107 — mesma correção já aplicada aos funcionários: gera já a despesa
    // de salário deste mês (categoria "Salários") em vez de esperar pelo
    // cron diário (6:10), para o admin ver o impacto no Dashboard >
    // Despesas imediatamente ao cadastrar. Idempotente; uma falha aqui não
    // deve impedir o cadastro do professor.
    try {
      await gerarDespesasSalariosDoMes(schoolId);
    } catch (erroDespesa) {
      console.error('[v0] Professor cadastrado, mas falhou ao gerar a despesa de salário do mês:', erroDespesa.message);
    }

    res.status(201).json({
      success: true,
      message: 'Professor cadastrado com sucesso',
      data: { ...professorCriado, disciplinas },
    });
  } catch (err) {
    console.error('[v0] Erro ao cadastrar professor:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Email ou código de professor já cadastrado' });
    }
    res.status(500).json({ success: false, message: 'Erro interno ao cadastrar professor', error: err.message });
  }
};

/**
 * PUT: Atualizar dados de um professor
 */
export const updateTeacher = async (req, res) => {
  try {
    const { schoolId, teacherId } = req.params;
    const {
      nome,
      idade,
      genero,
      salario,
      contacto,
      telefone,
      gmail,
      email,
      morada,
      documento,
      tipo_contrato,
      data_admissao,
      ativo,
      password,
      disciplinas,
    } = req.body;

    const existentes = await queryAsync(`SELECT * FROM teachers WHERE id = ? AND school_id = ?`, [teacherId, schoolId]);
    if (existentes.length === 0) {
      return res.status(404).json({ success: false, message: 'Professor não encontrado' });
    }
    const professorAntigo = existentes[0];

    if (tipo_contrato !== undefined && tipo_contrato !== null && tipo_contrato !== '' && !TIPOS_CONTRATO_VALIDOS.includes(tipo_contrato)) {
      return res.status(400).json({ success: false, message: `Tipo de contrato inválido. Use um de: ${TIPOS_CONTRATO_VALIDOS.join(', ')}` });
    }
    if (tipo_contrato !== undefined || data_admissao !== undefined) {
      await ensureTeachersColunasAdministrativas();
    }

    const campos = [];
    const valores = [];

    if (nome !== undefined) { campos.push('nome = ?'); valores.push(String(nome).trim()); }
    if (email !== undefined || gmail !== undefined) { campos.push('email = ?'); valores.push(email || gmail || null); }
    if (telefone !== undefined || contacto !== undefined) { campos.push('telefone = ?'); valores.push(telefone || contacto || null); }
    if (idade !== undefined) { campos.push('idade = ?'); valores.push(parseInt(idade, 10)); }
    if (genero !== undefined) { campos.push('genero = ?'); valores.push(genero); }
    if (salario !== undefined) { campos.push('salario = ?'); valores.push(parseFloat(salario)); }
    if (morada !== undefined) { campos.push('morada = ?'); valores.push(morada); }
    if (documento !== undefined) { campos.push('documento = ?'); valores.push(documento); }
    if (tipo_contrato !== undefined) { campos.push('tipo_contrato = ?'); valores.push(tipo_contrato || null); }
    if (data_admissao !== undefined) { campos.push('data_admissao = ?'); valores.push(data_admissao || null); }
    if (ativo !== undefined) { campos.push('ativo = ?'); valores.push(ativo ? 1 : 0); }

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Senha deve ter no mínimo 6 caracteres' });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      campos.push('password = ?');
      valores.push(hashedPassword);
    }

    if (campos.length > 0) {
      campos.push('updated_at = NOW()');
      valores.push(teacherId, schoolId);
      await queryAsync(
        `UPDATE teachers SET ${campos.join(', ')} WHERE id = ? AND school_id = ?`,
        valores
      );
    }

    if (Array.isArray(disciplinas)) {
      const disciplinaIds = await getOrCreateDisciplinaIds(schoolId, disciplinas);
      await setTeacherDisciplinas(teacherId, disciplinaIds);
    }

    // v107 — mesma correção de teacherController: se o salário mudou, ou o
    // professor acabou de ser reativado a meio do mês (ainda não havia
    // despesa deste mês para ele), garante que a despesa do mês corrente é
    // gerada já — idempotente, não duplica nem corrige retroativamente
    // meses já lançados.
    if (salario !== undefined || ativo === true) {
      try {
        await gerarDespesasSalariosDoMes(schoolId);
      } catch (erroDespesa) {
        console.error('[v0] Professor atualizado, mas falhou ao gerar/verificar a despesa de salário do mês:', erroDespesa.message);
      }
    }

    // eslint-disable-next-line no-unused-vars
    const { password: _senhaAntiga, ...professorAntigoSemSenha } = professorAntigo;
    await registrarAuditoria(req, {
      acao: 'professor_editado', entidadeTipo: 'teacher', entidadeId: teacherId,
      dadosAntigos: professorAntigoSemSenha,
      dadosNovos: { nome, email: email || gmail, telefone: telefone || contacto, salario, ativo, tipo_contrato, senha_alterada: !!password },
    });

    res.json({ success: true, message: 'Professor atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar professor', error: err.message });
  }
};

/**
 * DELETE: Remover (desativar) um professor
 */
export const deleteTeacher = async (req, res) => {
  try {
    const { schoolId, teacherId } = req.params;

    const [professor] = await queryAsync(`SELECT id, nome, email, ativo FROM teachers WHERE id = ? AND school_id = ?`, [teacherId, schoolId]);
    if (!professor) {
      return res.status(404).json({ success: false, message: 'Professor não encontrado' });
    }

    const result = await queryAsync(
      `UPDATE teachers SET ativo = FALSE, updated_at = NOW() WHERE id = ? AND school_id = ?`,
      [teacherId, schoolId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Professor não encontrado' });
    }

    await registrarAuditoria(req, {
      acao: 'professor_removido', entidadeTipo: 'teacher', entidadeId: teacherId, dadosAntigos: professor,
    });

    res.json({ success: true, message: 'Professor desativado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover professor', error: err.message });
  }
};
