// ═══════════════════════════════════════════════════════════════════════════════
// v122 — MIGRAÇÃO CENTRALIZADA DE ARRANQUE (ensureAllTables)
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA ENCONTRADO: cada controller/serviço tem a sua própria função
// "ensureXxx" (CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN), mas essas
// funções só corriam de forma "preguiçosa" — na primeira vez que um pedido
// batia numa rota daquele ficheiro. Isso significa que a tabela/coluna X só
// passava a existir depois de o administrador abrir a aba que a cria.
//
// Já tínhamos UM caso deste bug corrigido (horarioController a recriar
// class_disciplinas porque a aba "Horários" podia ser aberta antes da aba
// "Disciplinas"). Mas o padrão é sistémico: auditámos TODO o backend e
// encontrámos o mesmo risco em mais de 40 funções de auto-migração espalhadas
// por ~30 ficheiros (ex.: abrir "Renovações" antes de "Ano Letivo" também
// podia falhar por falta de academic_years; abrir "Relatórios" antes de
// "Funcionários" podia falhar por falta de funcionarios; etc.).
//
// SOLUÇÃO: este ficheiro importa TODAS essas funções "ensureXxx" (agora
// exportadas — antes muitas eram privadas ao seu próprio controller) e
// corre-as TODAS, uma vez, no arranque do servidor (ver server.js), ANTES de
// aceitar qualquer pedido. A partir daí, TODAS as tabelas/colunas existem
// desde o primeiro pedido, independentemente de qual aba o administrador,
// professor ou aluno abrir primeiro.
//
// Isto NÃO substitui as chamadas "ensureXxx()" que já existem no início de
// cada rota — mantivemo-las de propósito, como rede de segurança (ex.: se uma
// instalação antiga correr este ficheiro sem reiniciar o processo, ou se uma
// função nova for adicionada e esquecida aqui). Como todas usam memoize()
// (cache "correu uma vez, nunca mais verifica"), essas chamadas por pedido
// tornam-se instantâneas (no-op) depois desta migração de arranque correr —
// não há duplicação de custo em produção.
//
// IMPORTANTE: cada função corre dentro do seu próprio try/catch. Uma falha
// isolada (ex.: uma tabela específica com um esquema antigo incompatível
// nalguma instalação) fica registada claramente na consola, mas NÃO impede
// as restantes migrações de correr nem impede o servidor de arrancar — a
// mesma filosofia do resilientQuery.js: uma falha não pode derrubar tudo o
// resto que não depende dela.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Perfil da escola / funcionários / documentos ──
import { ensureSchoolProfileColumnsExist } from '../controllers/schoolController.js';
import { ensureFuncionariosTableExists } from '../controllers/funcionarioController.js';
import { ensureTabelaExists as ensureTabelaFuncionarioDocumentos } from '../controllers/funcionarioDocumentosController.js';
import { ensureTabelaExists as ensureTabelaProfessorDocumentos } from '../controllers/professorDocumentosController.js';
import { ensureTabelaExists as ensureTabelaAlunoDocumentos } from '../controllers/alunoDocumentosController.js';
import { ensureTabelaExists as ensureTabelaAlunoComunicacao } from '../controllers/alunoComunicacaoController.js';
// v141 — Documentos oficiais (Declaração / Certificado de Aproveitamento Escolar)
import { ensureTabelaExists as ensureTabelaDocumentosOficiais } from '../controllers/documentosOficiaisController.js';

// ── Alunos / matrícula / secções ──
import {
  ensureStudentPasswordColumnExists,
  ensureEnrollmentHistoryTableExists,
  ensureGuardiansColumnsExist,
} from '../controllers/studentController.js';
import {
  ensureSecoesTableExists,
  ensureTurmaSecaoColumnExists,
  ensureClassDisciplinaSecaoColumnExists,
  ensureSecaoSettingsTableExists,
  ensureTurmaMistaColumnExists,
  ensureStudentSecaoColumnExists,
} from '../controllers/secaoController.js';
import { ensureTurmaAcademicYearColumn } from '../controllers/turmaController.js';

// ── Currículo / classes / avaliação / presença (config) ──
import {
  ensureClassDisciplinasTableExists as ensureClassDisciplinasTableExistsCurriculo,
  ensureAvaliacaoConfigTableExists as ensureAvaliacaoConfigTableExistsCurriculo,
  ensurePresencaConfigTableExists as ensurePresencaConfigTableExistsCurriculo,
} from '../controllers/curriculoController.js';

// ── Notas (grade) — cria/alinha as MESMAS tabelas que curriculoController,
// de forma independente (ver comentário no próprio gradeController.js) ──
import {
  ensureGradeColumnsExist,
  ensureClassDisciplinasTableExists as ensureClassDisciplinasTableExistsGrade,
  ensureAvaliacaoConfigTableExists as ensureAvaliacaoConfigTableExistsGrade,
  ensurePresencaConfigTableExists as ensurePresencaConfigTableExistsGrade,
} from '../controllers/gradeController.js';

// ── Pauta de Frequência e Resultados (v137) — configuração académica por classe ──
import { ensureConfiguracaoAcademicaClasseTableExists } from '../services/configuracaoAcademicaService.js';

// ── Pauta de Exame por Júri (v150) — juris_exame/juri_membros + tem_exame por disciplina ──
import {
  ensureJurisExameTablesExist,
  ensureClassDisciplinaTemExameColumnExists,
} from '../services/pautaExameService.js';

// ── Horários / turnos / salas / indisponibilidade de professores ──
import {
  ensureTurnoIdColumnExists,
  ensureTabelasHorario,
  ensureTabelaIndisponibilidade as ensureTabelaIndisponibilidadeHorario,
} from '../controllers/horarioController.js';
import { ensureTabelaIndisponibilidade as ensureTabelaIndisponibilidadeConflitos } from '../controllers/conflitosHorarioController.js';
import { ensureSalasTableExists } from '../controllers/salaController.js';

// ── Presença / frequência ──
import { ensurePresencasTableExists } from '../controllers/attendanceController.js';

// ── Financeiro (mensalidades, multas, matrícula, previsão) ──
import { ensureMultasConfigColumnsExist } from '../controllers/mensalidades.controller.js';
import {
  ensurePaymentColumnsExist,
  ensureEnrollmentFeeTableExists,
} from '../services/financialStatusService.js';

// ── Renovação de matrícula / ano letivo ──
import { ensureRenewalWindowColumnsExist } from '../services/enrollmentStatusService.js';
import { ensureAcademicYearsTable } from '../services/academicYearService.js';

// ── Dashboard / despesas / eventos escolares ──
import { ensureTabelas as ensureTabelasDashboard } from '../controllers/dashboardController.js';

// ── Disciplina / ocorrências ──
import { ensureTabela as ensureTabelaDisciplinar } from '../controllers/disciplinarController.js';

// ── Tarefas (professor → alunos) ──
import { ensureTabelas as ensureTabelasTarefas } from '../controllers/tarefasController.js';

// ── Biblioteca ──
import { ensureTabelaBibliotecaExists } from '../controllers/bibliotecaController.js';

// ── Comunicação (mensagens internas, comunicados em massa, WhatsApp) ──
import { ensureTabelas as ensureTabelasComunicacao } from '../controllers/comunicacaoController.js';
import { ensureTabelas as ensureTabelasMensagensInternas } from '../controllers/mensagensInternasController.js';
import {
  ensureTabelaLog as ensureTabelaLogNotificacaoRelatorio,
  ensureColunasGuardians as ensureColunasGuardiansNotificacaoRelatorio,
} from '../services/notificacaoRelatorioService.js';

// ── Notificações / auditoria / automação / radar / área restrita ──
import {
  ensureNotificationsTableExists,
  ensureTargetColumnsExist,
} from '../services/notificationService.js';
import { ensureAuditLogsTableExists } from '../services/auditService.js';
import { ensureTabelas as ensureTabelasAutomation } from '../services/automationService.js';
import { ensureRadarConfigTableExists } from '../services/radarConfigService.js';
import { ensureTabelasAreaRestrita } from '../controllers/areaRestritaController.js';

// ── Professores (dados administrativos, carga horária, logs) ──
import { ensureTudo as ensureTudoTeacherAdmin } from '../controllers/teacherAdminController.js';

// ── Permissões granulares por perfil (v123) ──
import { ensureTabelasPermissoes } from '../services/permissionService.js';

// Lista ordenada apenas por legibilidade — todas as migrações são idempotentes
// (CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN com verificação
// prévia) e não têm dependências de chave estrangeira entre si (a única FK
// entre tabelas criadas aqui é `salas.school_id → schools(id)`, e `schools` já
// existe antes do servidor arrancar), por isso a ordem de execução abaixo não
// é sensível — o objetivo é simplesmente "todas antes de aceitar pedidos".
const MIGRACOES = [
  ['schoolController.ensureSchoolProfileColumnsExist', ensureSchoolProfileColumnsExist],
  ['funcionarioController.ensureFuncionariosTableExists', ensureFuncionariosTableExists],
  ['funcionarioDocumentosController.ensureTabelaExists', ensureTabelaFuncionarioDocumentos],
  ['professorDocumentosController.ensureTabelaExists', ensureTabelaProfessorDocumentos],
  ['alunoDocumentosController.ensureTabelaExists', ensureTabelaAlunoDocumentos],
  ['alunoComunicacaoController.ensureTabelaExists', ensureTabelaAlunoComunicacao],
  ['documentosOficiaisController.ensureTabelaExists', ensureTabelaDocumentosOficiais],

  ['studentController.ensureStudentPasswordColumnExists', ensureStudentPasswordColumnExists],
  ['studentController.ensureEnrollmentHistoryTableExists', ensureEnrollmentHistoryTableExists],
  ['studentController.ensureGuardiansColumnsExist', ensureGuardiansColumnsExist],
  ['secaoController.ensureSecoesTableExists', ensureSecoesTableExists],
  ['secaoController.ensureTurmaSecaoColumnExists', ensureTurmaSecaoColumnExists],
  ['secaoController.ensureClassDisciplinaSecaoColumnExists', ensureClassDisciplinaSecaoColumnExists],
  ['secaoController.ensureSecaoSettingsTableExists', ensureSecaoSettingsTableExists],
  ['secaoController.ensureTurmaMistaColumnExists', ensureTurmaMistaColumnExists],
  ['secaoController.ensureStudentSecaoColumnExists', ensureStudentSecaoColumnExists],
  ['turmaController.ensureTurmaAcademicYearColumn', ensureTurmaAcademicYearColumn],

  ['curriculoController.ensureClassDisciplinasTableExists', ensureClassDisciplinasTableExistsCurriculo],
  ['curriculoController.ensureAvaliacaoConfigTableExists', ensureAvaliacaoConfigTableExistsCurriculo],
  ['curriculoController.ensurePresencaConfigTableExists', ensurePresencaConfigTableExistsCurriculo],
  ['gradeController.ensureGradeColumnsExist', ensureGradeColumnsExist],
  ['gradeController.ensureClassDisciplinasTableExists', ensureClassDisciplinasTableExistsGrade],
  ['gradeController.ensureAvaliacaoConfigTableExists', ensureAvaliacaoConfigTableExistsGrade],
  ['gradeController.ensurePresencaConfigTableExists', ensurePresencaConfigTableExistsGrade],
  ['configuracaoAcademicaService.ensureConfiguracaoAcademicaClasseTableExists', ensureConfiguracaoAcademicaClasseTableExists],
  ['pautaExameService.ensureJurisExameTablesExist', ensureJurisExameTablesExist],
  ['pautaExameService.ensureClassDisciplinaTemExameColumnExists', ensureClassDisciplinaTemExameColumnExists],

  ['horarioController.ensureTurnoIdColumnExists', ensureTurnoIdColumnExists],
  ['horarioController.ensureTabelasHorario', ensureTabelasHorario],
  ['horarioController.ensureTabelaIndisponibilidade', ensureTabelaIndisponibilidadeHorario],
  ['conflitosHorarioController.ensureTabelaIndisponibilidade', ensureTabelaIndisponibilidadeConflitos],
  ['salaController.ensureSalasTableExists', ensureSalasTableExists],

  ['attendanceController.ensurePresencasTableExists', ensurePresencasTableExists],

  ['mensalidadesController.ensureMultasConfigColumnsExist', ensureMultasConfigColumnsExist],
  ['financialStatusService.ensurePaymentColumnsExist', ensurePaymentColumnsExist],
  ['financialStatusService.ensureEnrollmentFeeTableExists', ensureEnrollmentFeeTableExists],

  ['enrollmentStatusService.ensureRenewalWindowColumnsExist', ensureRenewalWindowColumnsExist],
  ['academicYearService.ensureAcademicYearsTable', ensureAcademicYearsTable],

  ['dashboardController.ensureTabelas', ensureTabelasDashboard],

  ['disciplinarController.ensureTabela', ensureTabelaDisciplinar],

  ['tarefasController.ensureTabelas', ensureTabelasTarefas],

  ['bibliotecaController.ensureTabelaBibliotecaExists', ensureTabelaBibliotecaExists],

  ['comunicacaoController.ensureTabelas', ensureTabelasComunicacao],
  ['mensagensInternasController.ensureTabelas', ensureTabelasMensagensInternas],
  ['notificacaoRelatorioService.ensureTabelaLog', ensureTabelaLogNotificacaoRelatorio],
  ['notificacaoRelatorioService.ensureColunasGuardians', ensureColunasGuardiansNotificacaoRelatorio],

  ['notificationService.ensureNotificationsTableExists', ensureNotificationsTableExists],
  ['notificationService.ensureTargetColumnsExist', ensureTargetColumnsExist],
  ['auditService.ensureAuditLogsTableExists', ensureAuditLogsTableExists],
  ['automationService.ensureTabelas', ensureTabelasAutomation],
  ['radarConfigService.ensureRadarConfigTableExists', ensureRadarConfigTableExists],
  ['areaRestritaController.ensureTabelasAreaRestrita', ensureTabelasAreaRestrita],

  ['teacherAdminController.ensureTudo', ensureTudoTeacherAdmin],

  ['permissionService.ensureTabelasPermissoes', ensureTabelasPermissoes],
];

/**
 * Corre todas as migrações de auto-criação/alinhamento de esquema, uma vez,
 * no arranque do servidor — para que NENHUMA aba dependa da ordem em que é
 * aberta pela primeira vez. Ver server.js.
 */
export const ensureAllTables = async () => {
  const inicio = Date.now();
  let falhas = 0;

  console.log(`[migrations] A garantir ${MIGRACOES.length} tabelas/colunas antes de aceitar pedidos...`);

  for (const [nome, fn] of MIGRACOES) {
    try {
      await fn();
    } catch (err) {
      falhas++;
      // Não relançamos: uma migração com problema (ex.: esquema legado
      // incompatível nalguma instalação específica) não pode impedir as
      // restantes ~45 migrações de correr, nem impedir o servidor de
      // arrancar. A funcionalidade afetada por esta tabela específica pode
      // ficar indisponível até resolução, mas o resto do sistema continua
      // operacional — mesma filosofia do resilientQuery.js.
      console.error(`[migrations] ❌ Falhou "${nome}":`, err.message);
    }
  }

  const duracao = Date.now() - inicio;
  if (falhas === 0) {
    console.log(`[migrations] ✅ Todas as ${MIGRACOES.length} migrações de arranque concluídas (${duracao}ms).`);
  } else {
    console.warn(`[migrations] ⚠️ ${falhas} de ${MIGRACOES.length} migrações falharam (${duracao}ms) — ver erros acima. O servidor vai arrancar mesmo assim.`);
  }
};

export default ensureAllTables;
