import db from '../config/db.js';
import { ensureClassDisciplinaSecaoColumnExists, ensureTurmaSecaoColumnExists } from './secaoController.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const columnExists = async (table, column) => {
  const result = await queryAsync(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return result.length > 0;
};

// Cache simples em memória: cada "ensureXxx" migra a base de dados (CREATE
// TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN se faltar) — são operações
// idempotentes, mas não precisam de correr em CADA pedido. Com memoize(),
// corre uma vez (a primeira chamada depois de o servidor arrancar) e todas as
// chamadas seguintes ficam instantâneas, reduzindo uma ida à base de dados por
// pedido em todas as rotas que dependem destas tabelas.
const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};


const DIAS_SEMANA_PADRAO = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];

// ═══════════════════════════════════════════════════════════════════════════════
// TABELAS (auto-migração)
// ═══════════════════════════════════════════════════════════════════════════════
export const ensureTurnoIdColumnExists = async () => {
  // usado por outros controllers (ex.: turmaController) que também leem t.turno_id
  if (!(await columnExists('turmas', 'turno_id'))) {
    try {
      await queryAsync(`ALTER TABLE turmas ADD COLUMN turno_id INT NULL AFTER sala_id`);
    } catch (err) {
      // Corrida entre pedidos simultâneos (ex.: duas abas abertas ao mesmo tempo):
      // outro pedido pode ter criado a coluna entre o SHOW COLUMNS acima e este
      // ALTER TABLE. Se foi mesmo esse o caso ("coluna duplicada"), não é um erro
      // real — a coluna já existe, exatamente como queríamos. Qualquer outro erro
      // continua a ser propagado normalmente.
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }
};

export const ensureTabelasHorario = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS turnos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      nome VARCHAR(50) NOT NULL,
      hora_inicio TIME NOT NULL,
      hora_fim TIME NOT NULL,
      dias_semana VARCHAR(100) NOT NULL DEFAULT 'Segunda,Terça,Quarta,Quinta,Sexta',
      ativo TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_school (school_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ⚠️ CREATE TABLE IF NOT EXISTS não faz nada se `turnos` já existir a partir
  // de uma versão anterior (ex.: sem hora_inicio/hora_fim). Sem isto, listar,
  // criar ou editar turnos falhava com "Unknown column 'hora_inicio'" em
  // bases de dados já em produção. Mesmo padrão de auto-migração usado no
  // resto do sistema (columnExists + ALTER TABLE ADD COLUMN).
  const turnosColunasNovas = [
    { nome: 'hora_inicio', ddl: "ADD COLUMN hora_inicio TIME NOT NULL DEFAULT '07:00:00' AFTER nome" },
    { nome: 'hora_fim', ddl: "ADD COLUMN hora_fim TIME NOT NULL DEFAULT '12:00:00' AFTER hora_inicio" },
    { nome: 'dias_semana', ddl: "ADD COLUMN dias_semana VARCHAR(100) NOT NULL DEFAULT 'Segunda,Terça,Quarta,Quinta,Sexta' AFTER hora_fim" },
    { nome: 'ativo', ddl: "ADD COLUMN ativo TINYINT(1) NOT NULL DEFAULT 1 AFTER dias_semana" },
  ];
  for (const coluna of turnosColunasNovas) {
    if (!(await columnExists('turnos', coluna.nome))) {
      try {
        await queryAsync(`ALTER TABLE turnos ${coluna.ddl}`);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') throw err;
      }
    }
  }

  // ⚠️ O create-db-template.sql original cria `turnos` com colunas
  // DIFERENTES das que este controller usa: `horario_inicio`/`horario_fim`
  // (em vez de `hora_inicio`/`hora_fim`) e SEM `dias_semana`, ambas
  // `TIME NOT NULL` sem valor por omissão. Numa base de dados criada a
  // partir desse template, o ALTER TABLE acima só acrescenta as colunas
  // novas — as antigas continuam lá, obrigatórias, e o INSERT deste
  // controller (que não as preenche) falhava com "Field 'horario_inicio'
  // doesn't have a default value". Relaxamos essas colunas legadas para
  // aceitarem NULL, mesmo padrão já usado abaixo para horarios.teacher_id.
  for (const legado of ['horario_inicio', 'horario_fim']) {
    try {
      const colunas = await queryAsync(`SHOW COLUMNS FROM turnos LIKE ?`, [legado]);
      if (colunas.length > 0 && String(colunas[0].Null).toUpperCase() === 'NO') {
        await queryAsync(`ALTER TABLE turnos MODIFY COLUMN ${legado} TIME NULL`);
      }
    } catch (err) {
      console.error(`[v0] Aviso: não foi possível relaxar turnos.${legado}:`, err.message);
    }
  }

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS horario_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL UNIQUE,
      duracao_aula_minutos INT NOT NULL DEFAULT 45,
      intervalo_minutos INT NOT NULL DEFAULT 20,
      aulas_antes_intervalo INT NOT NULL DEFAULT 3,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS disciplina_frequencia (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      classe_id INT NOT NULL,
      disciplina_id INT NOT NULL,
      aulas_por_semana INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_classe_disciplina (classe_id, disciplina_id),
      KEY idx_school (school_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // v103: "aula dupla" — quando marcada, o gerador de horário agenda essa
  // disciplina em blocos de 2 tempos SEGUIDOS no mesmo dia (ex.: Matemática
  // no 1º e 2º tempo), em vez de espalhar cada aula num dia/tempo diferente
  // como faz por omissão. Ver alocarAulasNaGrade().
  if (!(await columnExists('disciplina_frequencia', 'aula_dupla'))) {
    try {
      await queryAsync(`ALTER TABLE disciplina_frequencia ADD COLUMN aula_dupla TINYINT(1) NOT NULL DEFAULT 0 AFTER aulas_por_semana`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  // BUG CORRIGIDO: "Frequência Semanal" e "Gerar Horário" (abaixo) dependem da
  // tabela class_disciplinas (quais disciplinas cada classe tem) para saber que
  // disciplinas agendar — mas essa tabela só era criada pelo curriculoController.js
  // (aba Disciplinas → Currículo por Classe). Se o administrador abrisse "Horários"
  // ANTES de alguma vez ter aberto essa aba, a tabela ainda não existia e o pedido
  // falhava com um erro de base de dados ("Table 'class_disciplinas' doesn't exist").
  // Criamos a tabela aqui também (idempotente — CREATE TABLE IF NOT EXISTS, mesmo
  // esquema usado em curriculoController.js) para que a aba Horários funcione de
  // forma independente, sem depender da ordem em que o administrador visita as abas.
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS class_disciplinas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      classe_id INT NOT NULL,
      disciplina_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_classe_disciplina (classe_id, disciplina_id),
      KEY idx_school (school_id),
      KEY idx_classe (classe_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS horarios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      turma_id INT NOT NULL,
      disciplina_id INT NOT NULL,
      teacher_id INT NULL,
      sala_id INT NOT NULL,
      turno_id INT NOT NULL,
      dia_semana VARCHAR(20) NOT NULL,
      ordem INT NOT NULL,
      ativo BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_school_turma (school_id, turma_id),
      KEY idx_teacher_dia (teacher_id, dia_semana)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ── ALINHAMENTO COM O ESQUEMA REAL DA BASE DE DADOS (schema.sql do projeto) ──
  // A tabela `horarios` do schema oficial usa nomes diferentes dos que este
  // ficheiro usava antes: `teacher_id` (não `professor_id`), `sala_id` e
  // `turno_id` obrigatórios, e `ordem` (a Nª aula do dia) em vez de guardar
  // `hora_inicio`/`hora_fim` diretamente — a hora real é sempre calculada a
  // partir do turno + configuração da aula (ver calcularSlotsDoDia). Se a
  // tabela já existir a partir do schema.sql (normalmente com `teacher_id`
  // obrigatório), relaxamos essa coluna para aceitar NULL — nem toda escola
  // já tem professor atribuído a cada disciplina no momento de gerar o
  // horário, e isso não deve impedir a geração.
  try {
    const colunas = await queryAsync(`SHOW COLUMNS FROM horarios LIKE 'teacher_id'`);
    if (colunas.length > 0 && String(colunas[0].Null).toUpperCase() === 'NO') {
      await queryAsync(`ALTER TABLE horarios MODIFY COLUMN teacher_id INT NULL`);
    }
  } catch (err) {
    console.error('[v0] Aviso: não foi possível verificar/ajustar horarios.teacher_id:', err.message);
  }

  await ensureTurnoIdColumnExists();
});

export const getOrCreateHorarioConfig = async (schoolId) => {
  const rows = await queryAsync(`SELECT * FROM horario_config WHERE school_id = ? LIMIT 1`, [schoolId]);
  if (rows.length > 0) return rows[0];
  await queryAsync(
    `INSERT INTO horario_config (school_id, duracao_aula_minutos, intervalo_minutos, aulas_antes_intervalo, created_at, updated_at)
     VALUES (?, 45, 20, 3, NOW(), NOW())`,
    [schoolId]
  );
  const novaLinha = await queryAsync(`SELECT * FROM horario_config WHERE school_id = ? LIMIT 1`, [schoolId]);
  return novaLinha[0];
};

// ═══════════════════════════════════════════════════════════════════════════════
// TURNOS — definidos pelo administrador
// ═══════════════════════════════════════════════════════════════════════════════
export const getTurnos = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId } = req.params;
    const turnos = await queryAsync(`SELECT * FROM turnos WHERE school_id = ? ORDER BY hora_inicio ASC`, [schoolId]);
    res.json({ success: true, data: turnos });
  } catch (err) {
    console.error('[v0] Erro ao listar turnos:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar turnos', error: err.message });
  }
};

export const createTurno = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId } = req.params;
    const { nome, hora_inicio, hora_fim, dias_semana } = req.body;

    if (!nome?.trim() || !hora_inicio || !hora_fim) {
      return res.status(400).json({ success: false, message: 'Nome, hora de início e hora de fim são obrigatórios' });
    }
    if (hora_inicio >= hora_fim) {
      return res.status(400).json({ success: false, message: 'A hora de início deve ser antes da hora de fim' });
    }
    const diasStr = Array.isArray(dias_semana) && dias_semana.length > 0 ? dias_semana.join(',') : DIAS_SEMANA_PADRAO.join(',');

    const inserido = await queryAsync(
      `INSERT INTO turnos (school_id, nome, hora_inicio, hora_fim, dias_semana, ativo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [schoolId, nome.trim(), hora_inicio, hora_fim, diasStr]
    );
    res.status(201).json({ success: true, message: 'Turno criado com sucesso', id: inserido.insertId });
  } catch (err) {
    console.error('[v0] Erro ao criar turno:', err);
    res.status(500).json({ success: false, message: 'Erro ao criar turno', error: err.message });
  }
};

export const updateTurno = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId, turnoId } = req.params;
    const { nome, hora_inicio, hora_fim, dias_semana, ativo } = req.body;

    if (hora_inicio && hora_fim && hora_inicio >= hora_fim) {
      return res.status(400).json({ success: false, message: 'A hora de início deve ser antes da hora de fim' });
    }
    const diasStr = Array.isArray(dias_semana) ? dias_semana.join(',') : undefined;

    const campos = [];
    const valores = [];
    if (nome !== undefined) { campos.push('nome = ?'); valores.push(nome.trim()); }
    if (hora_inicio !== undefined) { campos.push('hora_inicio = ?'); valores.push(hora_inicio); }
    if (hora_fim !== undefined) { campos.push('hora_fim = ?'); valores.push(hora_fim); }
    if (diasStr !== undefined) { campos.push('dias_semana = ?'); valores.push(diasStr); }
    if (ativo !== undefined) { campos.push('ativo = ?'); valores.push(ativo ? 1 : 0); }
    if (campos.length === 0) return res.status(400).json({ success: false, message: 'Nada para atualizar' });

    campos.push('updated_at = NOW()');
    valores.push(turnoId, schoolId);

    const resultado = await queryAsync(`UPDATE turnos SET ${campos.join(', ')} WHERE id = ? AND school_id = ?`, valores);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Turno não encontrado' });
    res.json({ success: true, message: 'Turno atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar turno:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar turno', error: err.message });
  }
};

export const deleteTurno = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId, turnoId } = req.params;
    const emUso = await queryAsync(`SELECT COUNT(*) as total FROM turmas WHERE school_id = ? AND turno_id = ?`, [schoolId, turnoId]);
    if ((emUso[0]?.total || 0) > 0) {
      return res.status(400).json({ success: false, message: `Não é possível excluir: ${emUso[0].total} turma(s) usam este turno. Reatribua-as primeiro.` });
    }
    const resultado = await queryAsync(`DELETE FROM turnos WHERE id = ? AND school_id = ?`, [turnoId, schoolId]);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Turno não encontrado' });
    res.json({ success: true, message: 'Turno excluído com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao excluir turno:', err);
    res.status(500).json({ success: false, message: 'Erro ao excluir turno', error: err.message });
  }
};

// Atribui um turno a uma turma — é assim que "a turma fica em harmonia com o turno"
export const atribuirTurnoTurma = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId, turmaId } = req.params;
    const { turno_id } = req.body;

    if (turno_id) {
      const turnoValido = await queryAsync(`SELECT id FROM turnos WHERE id = ? AND school_id = ?`, [turno_id, schoolId]);
      if (turnoValido.length === 0) return res.status(400).json({ success: false, message: 'Turno inválido' });
    }

    const resultado = await queryAsync(`UPDATE turmas SET turno_id = ? WHERE id = ? AND school_id = ?`, [turno_id || null, turmaId, schoolId]);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Turma não encontrada' });
    res.json({ success: true, message: 'Turno da turma atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atribuir turno à turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao atribuir turno à turma', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO GERAL DO HORÁRIO (duração da aula, intervalo)
// ═══════════════════════════════════════════════════════════════════════════════
export const getHorarioConfig = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId } = req.params;
    const config = await getOrCreateHorarioConfig(schoolId);
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('[v0] Erro ao buscar configuração de horário:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar configuração de horário', error: err.message });
  }
};

export const salvarHorarioConfig = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId } = req.params;
    const { duracao_aula_minutos, intervalo_minutos, aulas_antes_intervalo } = req.body;

    const duracao = parseInt(duracao_aula_minutos, 10) || 45;
    const intervalo = parseInt(intervalo_minutos, 10) || 0;
    const aulasAntes = parseInt(aulas_antes_intervalo, 10) || 3;

    if (duracao < 20 || duracao > 120) {
      return res.status(400).json({ success: false, message: 'Duração da aula deve estar entre 20 e 120 minutos' });
    }
    if (intervalo < 0 || intervalo > 60) {
      return res.status(400).json({ success: false, message: 'Intervalo deve estar entre 0 e 60 minutos' });
    }

    await getOrCreateHorarioConfig(schoolId); // garante que a linha existe
    await queryAsync(
      `UPDATE horario_config SET duracao_aula_minutos = ?, intervalo_minutos = ?, aulas_antes_intervalo = ?, updated_at = NOW() WHERE school_id = ?`,
      [duracao, intervalo, aulasAntes, schoolId]
    );
    res.json({ success: true, message: 'Configuração de horário salva com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar configuração de horário:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar configuração de horário', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FREQUÊNCIA SEMANAL — quantas vezes por semana uma classe tem cada disciplina
// ═══════════════════════════════════════════════════════════════════════════════
export const getFrequenciaDaClasse = async (req, res) => {
  try {
    await ensureTabelasHorario();
    await ensureClassDisciplinaSecaoColumnExists();
    const { schoolId, classeId } = req.params;
    const secaoId = Number(req.query.secao_id) || 0;

    const disciplinas = await queryAsync(
      `SELECT d.id, d.nome FROM class_disciplinas cd
       INNER JOIN disciplinas d ON d.id = cd.disciplina_id
       WHERE cd.school_id = ? AND cd.classe_id = ? AND cd.secao_id IN (0, ?) ORDER BY d.nome ASC`,
      [schoolId, classeId, secaoId]
    );
    const frequencias = await queryAsync(
      `SELECT disciplina_id, aulas_por_semana, aula_dupla FROM disciplina_frequencia WHERE school_id = ? AND classe_id = ?`,
      [schoolId, classeId]
    );
    const mapaFrequencia = Object.fromEntries(frequencias.map((f) => [f.disciplina_id, { aulas_por_semana: f.aulas_por_semana, aula_dupla: !!f.aula_dupla }]));

    const resultado = disciplinas.map((d) => ({
      disciplina_id: d.id,
      nome: d.nome,
      aulas_por_semana: mapaFrequencia[d.id]?.aulas_por_semana ?? 1,
      aula_dupla: mapaFrequencia[d.id]?.aula_dupla ?? false,
    }));

    res.json({ success: true, data: resultado });
  } catch (err) {
    console.error('[v0] Erro ao buscar frequência semanal da classe:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar frequência semanal da classe', error: err.message });
  }
};

export const salvarFrequenciaDaClasse = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId, classeId } = req.params;
    const { frequencias = [] } = req.body; // [{ disciplina_id, aulas_por_semana, aula_dupla }]

    for (const item of frequencias) {
      const aulas = parseInt(item.aulas_por_semana, 10) || 0;
      if (aulas < 0 || aulas > 15) {
        return res.status(400).json({ success: false, message: 'Aulas por semana deve estar entre 0 e 15' });
      }
    }

    for (const item of frequencias) {
      const aulas = parseInt(item.aulas_por_semana, 10) || 0;
      // "Aula dupla" só faz sentido com pelo menos 2 aulas/semana — se o
      // admin reduzir para 0 ou 1 sem desmarcar a opção, guardamos como
      // desativada em vez de deixar um estado sem efeito prático.
      const aulaDupla = !!item.aula_dupla && aulas >= 2;
      await queryAsync(
        `INSERT INTO disciplina_frequencia (school_id, classe_id, disciplina_id, aulas_por_semana, aula_dupla, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE aulas_por_semana = VALUES(aulas_por_semana), aula_dupla = VALUES(aula_dupla), updated_at = NOW()`,
        [schoolId, classeId, item.disciplina_id, aulas, aulaDupla ? 1 : 0]
      );
    }

    res.json({ success: true, message: 'Frequência semanal salva com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar frequência semanal da classe:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar frequência semanal da classe', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GERAÇÃO AUTOMÁTICA DE HORÁRIOS
// ═══════════════════════════════════════════════════════════════════════════════

// Calcula os "slots" (blocos de aula) de um dia, dado o turno e a config da escola
export const calcularSlotsDoDia = (horaInicioTurno, horaFimTurno, config) => {
  const paraMinutos = (hhmmss) => {
    const [h, m] = String(hhmmss).split(':').map(Number);
    return h * 60 + m;
  };
  const paraHora = (minutos) => {
    const h = Math.floor(minutos / 60) % 24;
    const m = minutos % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  };

  const inicio = paraMinutos(horaInicioTurno);
  const fim = paraMinutos(horaFimTurno);
  const duracao = config.duracao_aula_minutos;
  const intervalo = config.intervalo_minutos;
  const aulasAntesIntervalo = config.aulas_antes_intervalo;

  const slots = [];
  let cursor = inicio;
  let aulasSeguidas = 0;
  while (cursor + duracao <= fim) {
    slots.push({ hora_inicio: paraHora(cursor), hora_fim: paraHora(cursor + duracao) });
    cursor += duracao;
    aulasSeguidas++;
    if (intervalo > 0 && aulasAntesIntervalo > 0 && aulasSeguidas % aulasAntesIntervalo === 0 && cursor + duracao <= fim) {
      cursor += intervalo;
    }
  }
  return slots;
};

// ── DISPONIBILIDADE DO PROFESSOR — mesma tabela usada pelo motor de conflitos
// (conflitosHorarioController.js). Repetimos aqui o CREATE TABLE IF NOT EXISTS
// (idempotente, como o resto das auto-migrações do projeto) em vez de importar
// do outro ficheiro, para não criar uma dependência circular entre os dois
// controllers (conflitosHorarioController.js já importa deste ficheiro).
export const ensureTabelaIndisponibilidade = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS teacher_indisponibilidade (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      teacher_id INT NOT NULL,
      dia_semana VARCHAR(20) NOT NULL,
      turno_id INT NOT NULL,
      motivo VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_professor_slot (teacher_id, dia_semana, turno_id),
      KEY idx_school (school_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

/**
 * Motor de alocação — o "cérebro" partilhado entre gerarHorarioTurma (uma
 * turma) e gerarHorarioEscola (todas de uma vez). Recebe tudo já carregado
 * (frequências, professores por disciplina, ocupação atual) e devolve as
 * linhas prontas a inserir, SEM tocar na base de dados — quem chama decide
 * quando persistir. Respeita, por esta ordem, para cada aula da fila:
 *   1. Sala livre nesse dia/tempo (a turma já tem sala fixa atribuída)
 *   2. Professor(es) da disciplina livres nesse dia/tempo (sem outra turma)
 *   3. Professor(es) da disciplina disponíveis nesse dia/turno (sem pedido
 *      de indisponibilidade registado)
 * Se nenhuma combinação servir para uma aula, devolve falha com o motivo.
 *
 * v103 — AULA DUPLA: disciplinas marcadas com `aula_dupla` (ver Frequência
 * Semanal) têm as suas aulas agrupadas 2 a 2 e colocadas em TEMPOS SEGUIDOS
 * do mesmo dia (ex.: Matemática no 1º e 2º tempo), com o MESMO professor
 * nos dois tempos, em vez de espalhadas em dias/tempos diferentes como o
 * resto das disciplinas. Os pares são alocados ANTES das aulas avulsas —
 * são a parte mais difícil de encaixar (precisam de 2 tempos seguidos
 * livres), por isso entram enquanto a grade ainda está mais vazia. Se
 * aulas_por_semana for ímpar, a aula que sobra vira avulsa normal.
 */
const alocarAulasNaGrade = ({ schoolId, turma, dias, slotsPorDia, frequencias, professoresPorDisciplina, ocupacaoProfessor, ocupacaoSala, indisponibilidadeSet }) => {
  const totalAulasNecessarias = frequencias.reduce((soma, f) => soma + f.aulas_por_semana, 0);
  const totalSlotsDisponiveis = slotsPorDia.length * dias.length;
  if (totalAulasNecessarias > totalSlotsDisponiveis) {
    return {
      sucesso: false,
      mensagem: `As disciplinas de "${turma.nome}" precisam de ${totalAulasNecessarias} aula(s) por semana, mas o turno só tem espaço para ${totalSlotsDisponiveis}. Aumente a duração do turno, reduza a duração da aula, ou reduza a frequência das disciplinas.`,
    };
  }

  // Separa cada disciplina em pares (aula dupla — 2 tempos seguidos no
  // mesmo dia) e avulsas (1 tempo cada). Só disciplinas com aula_dupla
  // ativa geram pares; o resto segue exatamente como antes.
  const paresFila = []; // 1 item por PAR (2 tempos) a alocar
  const unicasRestantes = [];
  frequencias.forEach((f) => {
    let restante = f.aulas_por_semana;
    if (f.aula_dupla) {
      const qtdPares = Math.floor(restante / 2);
      for (let i = 0; i < qtdPares; i++) paresFila.push({ disciplina_id: f.disciplina_id, disciplina_nome: f.disciplina_nome });
      restante -= qtdPares * 2;
    }
    if (restante > 0) unicasRestantes.push({ disciplina_id: f.disciplina_id, disciplina_nome: f.disciplina_nome, restante });
  });

  // Grade: [dia][slotIndex] = aula | null
  const grade = {};
  dias.forEach((dia) => { grade[dia] = new Array(slotsPorDia.length).fill(null); });

  const disciplinasPorDia = {}; // "dia" -> Set(disciplina_id) já usadas nesse dia
  dias.forEach((dia) => { disciplinasPorDia[dia] = new Set(); });

  // ── 1) AULAS DUPLAS — precisam de 2 tempos seguidos livres no mesmo dia,
  // com sala livre nos dois e o MESMO professor disponível nos dois. ──────
  for (const par of paresFila) {
    // Candidatos (dia, slot inicial) ordenados por prioridade: primeiro os
    // dias onde esta disciplina ainda não apareceu (espalha pela semana),
    // depois — dentro disso — os pares de tempos SEM intervalo entre eles
    // (verdadeiramente "seguidos", sem pausa no meio).
    const candidatos = [];
    for (const dia of dias) {
      for (let slot = 0; slot < slotsPorDia.length - 1; slot++) {
        candidatos.push({
          dia,
          slot,
          diaNovo: !disciplinasPorDia[dia].has(par.disciplina_id),
          semIntervalo: slotsPorDia[slot].hora_fim === slotsPorDia[slot + 1].hora_inicio,
        });
      }
    }
    candidatos.sort((a, b) => (b.diaNovo - a.diaNovo) || (b.semIntervalo - a.semIntervalo));

    let posicionada = false;
    for (const cand of candidatos) {
      const { dia, slot } = cand;
      if (grade[dia][slot] !== null || grade[dia][slot + 1] !== null) continue;

      const ordem1 = slot + 1;
      const ordem2 = slot + 2;

      const chaveSala1 = `${turma.sala_id}|${dia}|${turma.turno_id}|${ordem1}`;
      const chaveSala2 = `${turma.sala_id}|${dia}|${turma.turno_id}|${ordem2}`;
      if (ocupacaoSala.has(chaveSala1) || ocupacaoSala.has(chaveSala2)) continue;

      const candidatosProfessor = professoresPorDisciplina[par.disciplina_id] || [];
      let professorEscolhido = null;
      if (candidatosProfessor.length > 0) {
        // Precisa do MESMO professor livre nos DOIS tempos seguidos.
        professorEscolhido = candidatosProfessor.find((profId) =>
          !ocupacaoProfessor.has(`${profId}|${dia}|${turma.turno_id}|${ordem1}`) &&
          !ocupacaoProfessor.has(`${profId}|${dia}|${turma.turno_id}|${ordem2}`) &&
          !indisponibilidadeSet.has(`${profId}|${dia}|${turma.turno_id}`)
        ) || null;
        if (!professorEscolhido) continue; // nenhum professor livre nos dois tempos — tenta o próximo candidato
      }

      grade[dia][slot] = { disciplina_id: par.disciplina_id, disciplina_nome: par.disciplina_nome, teacher_id: professorEscolhido, ordem: ordem1 };
      grade[dia][slot + 1] = { disciplina_id: par.disciplina_id, disciplina_nome: par.disciplina_nome, teacher_id: professorEscolhido, ordem: ordem2 };
      disciplinasPorDia[dia].add(par.disciplina_id);
      if (professorEscolhido) {
        ocupacaoProfessor.add(`${professorEscolhido}|${dia}|${turma.turno_id}|${ordem1}`);
        ocupacaoProfessor.add(`${professorEscolhido}|${dia}|${turma.turno_id}|${ordem2}`);
      }
      ocupacaoSala.add(chaveSala1);
      ocupacaoSala.add(chaveSala2);
      posicionada = true;
      break;
    }

    if (!posicionada) {
      return {
        sucesso: false,
        mensagem: `Não foi possível encaixar a aula dupla de "${par.disciplina_nome}" em "${turma.nome}" — faltam 2 tempos seguidos livres, no mesmo dia, com o mesmo professor disponível nos dois. Tente atribuir mais professores à disciplina, revisar a indisponibilidade, ou desativar "aula dupla" para ela.`,
      };
    }
  }

  // ── 2) AULAS AVULSAS — fila intercalada entre disciplinas (evita
  // empilhar a mesma disciplina), exatamente como antes da v103. ─────────
  const fila = [];
  let houveInsercao = true;
  while (houveInsercao) {
    houveInsercao = false;
    for (const item of unicasRestantes) {
      if (item.restante > 0) {
        fila.push({ disciplina_id: item.disciplina_id, disciplina_nome: item.disciplina_nome });
        item.restante--;
        houveInsercao = true;
      }
    }
  }

  for (const aula of fila) {
    let posicionada = false;

    // 1ª tentativa: dia onde a disciplina ainda não apareceu (espalha pela semana)
    for (const prioridade of [true, false]) {
      if (posicionada) break;
      for (const dia of dias) {
        if (posicionada) break;
        if (prioridade && disciplinasPorDia[dia].has(aula.disciplina_id)) continue;

        for (let slot = 0; slot < slotsPorDia.length; slot++) {
          if (grade[dia][slot] !== null) continue;

          const ordem = slot + 1; // "Nª aula do dia" — é assim que a tabela real identifica o horário (ver ordem)

          // SALA: a turma tem sala fixa — se essa sala já está ocupada por OUTRA
          // turma neste dia/tempo (mesmo turno), este slot não serve.
          const chaveSala = `${turma.sala_id}|${dia}|${turma.turno_id}|${ordem}`;
          if (ocupacaoSala.has(chaveSala)) continue;

          // PROFESSOR: livre neste slot E não marcado como indisponível
          // (indisponibilidade é por dia+turno inteiro, não por tempo específico).
          const professoresDisponiveis = (professoresPorDisciplina[aula.disciplina_id] || [])
            .filter((profId) => !ocupacaoProfessor.has(`${profId}|${dia}|${turma.turno_id}|${ordem}`))
            .filter((profId) => !indisponibilidadeSet.has(`${profId}|${dia}|${turma.turno_id}`));
          const professorEscolhido = professoresDisponiveis.length > 0 ? professoresDisponiveis[0] : null;

          // Se há professores cadastrados para a disciplina mas nenhum está livre/disponível neste slot, tenta o próximo slot
          if ((professoresPorDisciplina[aula.disciplina_id] || []).length > 0 && !professorEscolhido) continue;

          grade[dia][slot] = { ...aula, teacher_id: professorEscolhido, ordem, hora_inicio: slotsPorDia[slot].hora_inicio, hora_fim: slotsPorDia[slot].hora_fim };
          disciplinasPorDia[dia].add(aula.disciplina_id);
          if (professorEscolhido) ocupacaoProfessor.add(`${professorEscolhido}|${dia}|${turma.turno_id}|${ordem}`);
          ocupacaoSala.add(chaveSala);
          posicionada = true;
          break;
        }
      }
    }

    if (!posicionada) {
      return {
        sucesso: false,
        mensagem: `Não foi possível encaixar todas as aulas de "${aula.disciplina_nome}" em "${turma.nome}" sem sobrepor um professor, respeitar a indisponibilidade registada, ou por falta de sala livre. Tente atribuir mais professores a esta disciplina, revisar as indisponibilidades, ou reduzir a frequência semanal.`,
      };
    }
  }

  const linhasParaInserir = [];
  dias.forEach((dia) => {
    grade[dia].forEach((aula) => {
      if (aula) linhasParaInserir.push([schoolId, turma.id, aula.disciplina_id, aula.teacher_id, turma.sala_id, turma.turno_id, dia, aula.ordem]);
    });
  });

  return { sucesso: true, linhasParaInserir, totalAulas: linhasParaInserir.length };
};

const persistirLinhasHorario = async (linhas) => {
  if (linhas.length === 0) return;
  await queryAsync(
    `INSERT INTO horarios (school_id, turma_id, disciplina_id, teacher_id, sala_id, turno_id, dia_semana, ordem, ativo, created_at, updated_at)
     VALUES ${linhas.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())').join(', ')}`,
    linhas.flat()
  );
};

/**
 * Gera (e persiste) o horário semanal de uma turma:
 *  1. Usa o turno atribuído à turma para saber os dias e a janela de horário.
 *  2. Usa a frequência semanal configurada para a classe da turma (quantas aulas
 *     de cada disciplina por semana).
 *  3. Distribui as aulas pelos dias/slots, respeitando: professor livre (sem
 *     estar noutra turma no mesmo tempo), disponibilidade do professor (sem
 *     pedido de indisponibilidade nesse dia/turno) e sala livre (sem outra
 *     turma a usar a mesma sala no mesmo tempo).
 */
export const gerarHorarioTurma = async (req, res) => {
  try {
    await ensureTabelasHorario();
    await ensureTabelaIndisponibilidade();
    await ensureClassDisciplinaSecaoColumnExists();
    await ensureTurmaSecaoColumnExists();
    const { schoolId, turmaId } = req.params;

    const turmaRows = await queryAsync(
      `SELECT t.id, t.nome, t.class_id, t.secao_id, t.turno_id, t.sala_id, tn.nome as turno_nome, tn.hora_inicio, tn.hora_fim, tn.dias_semana
       FROM turmas t LEFT JOIN turnos tn ON tn.id = t.turno_id
       WHERE t.id = ? AND t.school_id = ? LIMIT 1`,
      [turmaId, schoolId]
    );
    if (turmaRows.length === 0) return res.status(404).json({ success: false, message: 'Turma não encontrada' });
    const turma = turmaRows[0];
    if (!turma.turno_id) {
      return res.status(400).json({ success: false, message: `A turma "${turma.nome}" ainda não tem um turno atribuído. Atribua um turno primeiro (aba Turmas).` });
    }
    if (!turma.sala_id) {
      return res.status(400).json({ success: false, message: `A turma "${turma.nome}" ainda não tem uma sala atribuída. Atribua uma sala primeiro (aba Turmas/Salas).` });
    }

    const config = await getOrCreateHorarioConfig(schoolId);
    const dias = String(turma.dias_semana || DIAS_SEMANA_PADRAO.join(',')).split(',').map((d) => d.trim()).filter(Boolean);
    const slotsPorDia = calcularSlotsDoDia(turma.hora_inicio, turma.hora_fim, config);

    if (slotsPorDia.length === 0) {
      return res.status(400).json({ success: false, message: 'O turno atribuído não tem tempo suficiente para caber nenhuma aula com a duração configurada.' });
    }

    // Frequência semanal das disciplinas desta classe — v94: só as
    // disciplinas que a SECÇÃO desta turma realmente tem (comuns + as
    // específicas da sua secção), para não gerar aulas de disciplinas de
    // outra secção da mesma classe (ex.: não gerar Física para uma turma da
    // secção "Letras" só porque "Ciências" da mesma classe tem Física).
    const frequencias = await queryAsync(
      `SELECT df.disciplina_id, df.aulas_por_semana, df.aula_dupla, d.nome as disciplina_nome
       FROM disciplina_frequencia df
       INNER JOIN disciplinas d ON d.id = df.disciplina_id
       INNER JOIN class_disciplinas cd ON cd.school_id = df.school_id AND cd.classe_id = df.classe_id AND cd.disciplina_id = df.disciplina_id
       WHERE df.school_id = ? AND df.classe_id = ? AND df.aulas_por_semana > 0 AND cd.secao_id IN (0, ?)`,
      [schoolId, turma.class_id, turma.secao_id || 0]
    );
    if (frequencias.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhuma disciplina com frequência semanal configurada para esta classe. Configure em "Frequência Semanal" primeiro.' });
    }

    // Professor disponível para cada disciplina (se houver um cadastrado que a lecione)
    const professoresPorDisciplina = {};
    for (const f of frequencias) {
      const profs = await queryAsync(
        `SELECT t.id FROM teachers t
         INNER JOIN teacher_disciplines td ON td.teacher_id = t.id
         WHERE t.school_id = ? AND t.ativo = 1 AND td.disciplina_id = ?`,
        [schoolId, f.disciplina_id]
      );
      professoresPorDisciplina[f.disciplina_id] = profs.map((p) => p.id);
    }

    // Ocupação (professor + sala) de TODOS os horários já existentes de OUTRAS
    // turmas, para não sobrepor. Como a tabela real não guarda hora_inicio/
    // hora_fim (usa `ordem`, a Nª aula do dia), comparamos por turno_id + dia +
    // ordem: dentro do MESMO turno, a mesma ordem corresponde sempre ao mesmo
    // horário real (todas as turmas desse turno partilham a mesma janela e
    // configuração de aula/intervalo).
    const ocupacaoProfessor = new Set(); // "teacherId|dia|turnoId|ordem"
    const ocupacaoSala = new Set(); // "salaId|dia|turnoId|ordem"
    const horariosExistentes = await queryAsync(
      `SELECT teacher_id, sala_id, dia_semana, turno_id, ordem FROM horarios WHERE school_id = ? AND turma_id != ? AND ativo = 1`,
      [schoolId, turmaId]
    );
    horariosExistentes.forEach((h) => {
      if (h.teacher_id) ocupacaoProfessor.add(`${h.teacher_id}|${h.dia_semana}|${h.turno_id}|${h.ordem}`);
      if (h.sala_id) ocupacaoSala.add(`${h.sala_id}|${h.dia_semana}|${h.turno_id}|${h.ordem}`);
    });

    // Indisponibilidade dos professores (dia/turno em que pediram para não dar aulas)
    const indisponibilidades = await queryAsync(
      `SELECT teacher_id, dia_semana, turno_id FROM teacher_indisponibilidade WHERE school_id = ?`,
      [schoolId]
    );
    const indisponibilidadeSet = new Set(indisponibilidades.map((i) => `${i.teacher_id}|${i.dia_semana}|${i.turno_id}`));

    const resultado = alocarAulasNaGrade({ schoolId, turma, dias, slotsPorDia, frequencias, professoresPorDisciplina, ocupacaoProfessor, ocupacaoSala, indisponibilidadeSet });
    if (!resultado.sucesso) {
      return res.status(409).json({ success: false, message: resultado.mensagem });
    }

    // Persiste: limpa o horário anterior da turma e grava o novo
    await queryAsync(`DELETE FROM horarios WHERE school_id = ? AND turma_id = ?`, [schoolId, turmaId]);
    await persistirLinhasHorario(resultado.linhasParaInserir);

    res.json({ success: true, message: `Horário gerado com sucesso para a turma "${turma.nome}" (${resultado.totalAulas} aula(s)).`, total_aulas: resultado.totalAulas });
  } catch (err) {
    console.error('[v0] Erro ao gerar horário da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao gerar horário da turma', error: err.message });
  }
};

/**
 * Gera (e persiste) o horário semanal da ESCOLA INTEIRA de uma vez:
 * repete a mesma lógica do gerarHorarioTurma para cada turma elegível (com
 * turno, sala e disciplinas configurados), mas partilhando a ocupação de
 * professores e salas ENTRE as turmas à medida que avança — assim, a turma
 * nº2 já sabe que o professor X está ocupado às terças de manhã porque foi
 * alocado à turma nº1 segundos antes. Turmas com mais aulas por semana são
 * processadas primeiro (são as mais difíceis de encaixar, por isso ganham
 * prioridade enquanto a grade ainda está mais vazia). Turmas sem turno/sala/
 * disciplinas configurados, ou que não coube nenhuma combinação possível,
 * ficam de fora e são reportadas — nada é assumido nem forçado.
 */
export const gerarHorarioEscola = async (req, res) => {
  try {
    await ensureTabelasHorario();
    await ensureTabelaIndisponibilidade();
    await ensureClassDisciplinaSecaoColumnExists();
    await ensureTurmaSecaoColumnExists();
    const { schoolId } = req.params;

    const config = await getOrCreateHorarioConfig(schoolId);

    const turmasRows = await queryAsync(
      `SELECT t.id, t.nome, t.class_id, t.secao_id, t.turno_id, t.sala_id, tn.nome as turno_nome, tn.hora_inicio, tn.hora_fim, tn.dias_semana
       FROM turmas t LEFT JOIN turnos tn ON tn.id = t.turno_id
       WHERE t.school_id = ?
       ORDER BY t.nome ASC`,
      [schoolId]
    );
    if (turmasRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Esta escola ainda não tem turmas cadastradas.' });
    }

    const puladas = [];
    const elegiveis = [];
    turmasRows.forEach((turma) => {
      if (!turma.turno_id) { puladas.push({ turma_id: turma.id, turma_nome: turma.nome, motivo: 'Sem turno atribuído' }); return; }
      if (!turma.sala_id) { puladas.push({ turma_id: turma.id, turma_nome: turma.nome, motivo: 'Sem sala atribuída' }); return; }
      elegiveis.push(turma);
    });
    if (elegiveis.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhuma turma tem turno e sala atribuídos. Configure isso primeiro na aba Turmas.', puladas });
    }

    // ── Caches partilhados entre turmas, para não repetir a mesma consulta
    // dezenas de vezes quando várias turmas partilham classe/turno/disciplina ──
    // v94: a chave do cache agora inclui a secção (classId:secaoId), para não
    // misturar as disciplinas de secções diferentes da mesma classe.
    const frequenciasPorClasse = {};
    const carregarFrequenciasDaClasse = async (classId, secaoId = 0) => {
      const chave = `${classId}:${secaoId || 0}`;
      if (frequenciasPorClasse[chave]) return frequenciasPorClasse[chave];
      const linhas = await queryAsync(
        `SELECT df.disciplina_id, df.aulas_por_semana, df.aula_dupla, d.nome as disciplina_nome
         FROM disciplina_frequencia df
         INNER JOIN disciplinas d ON d.id = df.disciplina_id
         INNER JOIN class_disciplinas cd ON cd.school_id = df.school_id AND cd.classe_id = df.classe_id AND cd.disciplina_id = df.disciplina_id
         WHERE df.school_id = ? AND df.classe_id = ? AND df.aulas_por_semana > 0 AND cd.secao_id IN (0, ?)`,
        [schoolId, classId, secaoId || 0]
      );
      frequenciasPorClasse[chave] = linhas;
      return linhas;
    };

    const professoresPorDisciplinaCache = {};
    const carregarProfessoresDaDisciplina = async (disciplinaId) => {
      if (professoresPorDisciplinaCache[disciplinaId]) return professoresPorDisciplinaCache[disciplinaId];
      const profs = await queryAsync(
        `SELECT t.id FROM teachers t
         INNER JOIN teacher_disciplines td ON td.teacher_id = t.id
         WHERE t.school_id = ? AND t.ativo = 1 AND td.disciplina_id = ?`,
        [schoolId, disciplinaId]
      );
      const ids = profs.map((p) => p.id);
      professoresPorDisciplinaCache[disciplinaId] = ids;
      return ids;
    };

    const slotsPorTurnoCache = {};
    const obterSlotsDoTurno = (turma) => {
      if (!slotsPorTurnoCache[turma.turno_id]) {
        slotsPorTurnoCache[turma.turno_id] = calcularSlotsDoDia(turma.hora_inicio, turma.hora_fim, config);
      }
      return slotsPorTurnoCache[turma.turno_id];
    };

    // Prepara cada turma elegível (frequências, professores por disciplina, dias, slots)
    const prontas = [];
    for (const turma of elegiveis) {
      const frequencias = await carregarFrequenciasDaClasse(turma.class_id, turma.secao_id);
      if (frequencias.length === 0) {
        puladas.push({ turma_id: turma.id, turma_nome: turma.nome, motivo: 'Nenhuma disciplina com frequência semanal configurada para a classe' });
        continue;
      }
      const dias = String(turma.dias_semana || DIAS_SEMANA_PADRAO.join(',')).split(',').map((d) => d.trim()).filter(Boolean);
      const slotsPorDia = obterSlotsDoTurno(turma);
      if (slotsPorDia.length === 0) {
        puladas.push({ turma_id: turma.id, turma_nome: turma.nome, motivo: 'O turno não tem tempo suficiente para nenhuma aula com a duração configurada' });
        continue;
      }
      const professoresPorDisciplina = {};
      for (const f of frequencias) {
        professoresPorDisciplina[f.disciplina_id] = await carregarProfessoresDaDisciplina(f.disciplina_id);
      }
      const totalAulasNecessarias = frequencias.reduce((s, f) => s + f.aulas_por_semana, 0);
      prontas.push({ turma, frequencias, dias, slotsPorDia, professoresPorDisciplina, totalAulasNecessarias });
    }

    if (prontas.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhuma turma elegível tinha disciplinas configuradas para gerar horário.', puladas });
    }

    // Turmas mais "pesadas" (mais aulas/semana) primeiro — ficam mais difíceis
    // de encaixar à medida que a grade enche, por isso entram enquanto ainda
    // há mais espaço livre.
    prontas.sort((a, b) => b.totalAulasNecessarias - a.totalAulasNecessarias);

    // Apaga o horário atual só das turmas que vão ser (re)geradas agora — as
    // que ficaram de fora (sem turno/sala/frequência) mantêm o que já tinham.
    const idsProntas = prontas.map((p) => p.turma.id);
    await queryAsync(
      `DELETE FROM horarios WHERE school_id = ? AND turma_id IN (${idsProntas.map(() => '?').join(',')})`,
      [schoolId, ...idsProntas]
    );

    // Ocupação inicial: o que sobrou na base (turmas fora desta geração) continua a valer.
    const ocupacaoProfessor = new Set();
    const ocupacaoSala = new Set();
    const horariosRestantes = await queryAsync(
      `SELECT teacher_id, sala_id, dia_semana, turno_id, ordem FROM horarios WHERE school_id = ? AND ativo = 1`,
      [schoolId]
    );
    horariosRestantes.forEach((h) => {
      if (h.teacher_id) ocupacaoProfessor.add(`${h.teacher_id}|${h.dia_semana}|${h.turno_id}|${h.ordem}`);
      if (h.sala_id) ocupacaoSala.add(`${h.sala_id}|${h.dia_semana}|${h.turno_id}|${h.ordem}`);
    });

    const indisponibilidades = await queryAsync(
      `SELECT teacher_id, dia_semana, turno_id FROM teacher_indisponibilidade WHERE school_id = ?`,
      [schoolId]
    );
    const indisponibilidadeSet = new Set(indisponibilidades.map((i) => `${i.teacher_id}|${i.dia_semana}|${i.turno_id}`));

    const sucesso = [];
    const falhas = [];
    const todasAsLinhas = [];

    for (const item of prontas) {
      // Tenta numa cópia da ocupação — só "confirma" (mescla de volta) se a
      // turma inteira encaixar; se falhar, a tentativa é descartada e as
      // próximas turmas nem sabem que ela foi tentada.
      const ocupacaoProfessorTentativa = new Set(ocupacaoProfessor);
      const ocupacaoSalaTentativa = new Set(ocupacaoSala);
      const resultado = alocarAulasNaGrade({
        schoolId,
        turma: item.turma,
        dias: item.dias,
        slotsPorDia: item.slotsPorDia,
        frequencias: item.frequencias,
        professoresPorDisciplina: item.professoresPorDisciplina,
        ocupacaoProfessor: ocupacaoProfessorTentativa,
        ocupacaoSala: ocupacaoSalaTentativa,
        indisponibilidadeSet,
      });
      if (resultado.sucesso) {
        ocupacaoProfessorTentativa.forEach((v) => ocupacaoProfessor.add(v));
        ocupacaoSalaTentativa.forEach((v) => ocupacaoSala.add(v));
        todasAsLinhas.push(...resultado.linhasParaInserir);
        sucesso.push({ turma_id: item.turma.id, turma_nome: item.turma.nome, total_aulas: resultado.totalAulas });
      } else {
        falhas.push({ turma_id: item.turma.id, turma_nome: item.turma.nome, motivo: resultado.mensagem });
      }
    }

    await persistirLinhasHorario(todasAsLinhas);

    res.json({
      success: true,
      message: `Horário gerado para ${sucesso.length} de ${prontas.length} turma(s) elegível(eis) (${todasAsLinhas.length} aula(s) no total).`,
      total_aulas: todasAsLinhas.length,
      total_turmas_elegiveis: prontas.length,
      sucesso,
      falhas,
      puladas,
    });
  } catch (err) {
    console.error('[v0] Erro ao gerar horário da escola inteira:', err);
    res.status(500).json({ success: false, message: 'Erro ao gerar horário da escola inteira', error: err.message });
  }
};

// GET: horário da turma já gerado, pronto para montar a tabela dias x tempos
export const getHorarioTurma = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId, turmaId } = req.params;

    const turmaRows = await queryAsync(
      `SELECT t.id, t.nome, tn.nome as turno_nome, tn.hora_inicio, tn.hora_fim, tn.dias_semana
       FROM turmas t LEFT JOIN turnos tn ON tn.id = t.turno_id
       WHERE t.id = ? AND t.school_id = ? LIMIT 1`,
      [turmaId, schoolId]
    );
    if (turmaRows.length === 0) return res.status(404).json({ success: false, message: 'Turma não encontrada' });
    const turma = turmaRows[0];

    const aulas = await queryAsync(
      `SELECT h.dia_semana, h.ordem, h.disciplina_id, d.nome as disciplina_nome, h.teacher_id, p.nome as professor_nome
       FROM horarios h
       INNER JOIN disciplinas d ON d.id = h.disciplina_id
       LEFT JOIN teachers p ON p.id = h.teacher_id
       WHERE h.school_id = ? AND h.turma_id = ? AND h.ativo = 1
       ORDER BY h.ordem ASC`,
      [schoolId, turmaId]
    );

    const config = await getOrCreateHorarioConfig(schoolId);
    const dias = turma.hora_inicio
      ? String(turma.dias_semana || DIAS_SEMANA_PADRAO.join(',')).split(',').map((d) => d.trim()).filter(Boolean)
      : DIAS_SEMANA_PADRAO;
    const slots = turma.hora_inicio ? calcularSlotsDoDia(turma.hora_inicio, turma.hora_fim, config) : [];

    // A tabela `horarios` guarda `ordem` (a Nª aula do dia), não a hora — a hora
    // real é sempre recalculada aqui a partir do turno + configuração da aula,
    // para que mudar a duração da aula/intervalo já reflita em todos os horários
    // gerados, sem precisar de regravar cada linha.
    const aulasComHorario = aulas.map((aula) => {
      const slot = slots[aula.ordem - 1];
      return { ...aula, hora_inicio: slot?.hora_inicio || null, hora_fim: slot?.hora_fim || null };
    });

    res.json({
      success: true,
      turma: { id: turma.id, nome: turma.nome, turno_nome: turma.turno_nome, hora_inicio: turma.hora_inicio, hora_fim: turma.hora_fim },
      dias,
      slots,
      aulas: aulasComHorario,
    });
  } catch (err) {
    console.error('[v0] Erro ao buscar horário da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar horário da turma', error: err.message });
  }
};

export const limparHorarioTurma = async (req, res) => {
  try {
    await ensureTabelasHorario();
    const { schoolId, turmaId } = req.params;
    await queryAsync(`DELETE FROM horarios WHERE school_id = ? AND turma_id = ?`, [schoolId, turmaId]);
    res.json({ success: true, message: 'Horário removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao limpar horário da turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao limpar horário da turma', error: err.message });
  }
};
