import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import "./config/db.js";
import "./config/jwt.js"; // ⚠️ Falha o arranque se JWT_SECRET não estiver definido — ver config/jwt.js
import path from "path";
import { fileURLToPath } from "url";
import { verifyTokenUploads } from "./middleware/authMiddleware.js";
import { apiLimiter } from "./middleware/rateLimiter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Importar rotas
import authRoutes from "./routes/authRoutes.js";
import schoolRoutes from "./routes/schoolRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import authSchoolAdminRoutes from "./routes/authSchoolAdmin.js";
import mensalidadesRoutes from "./routes/mensalidades.routes.js";
import studentRoutes from "./routes/studentRoutes.js"; // ✅ NOVA ROTA DE ALUNOS
import turmaRoutes from "./routes/turmaRoutes.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import disciplinaRoutes from "./routes/disciplinaRoutes.js";
import salaRoutes from "./routes/salaRoutes.js";
import gradeRoutes from "./routes/gradeRoutes.js";
import curriculoRoutes from "./routes/curriculoRoutes.js"; // ✅ CLASSES / CURRÍCULO / CONFIG. DE AVALIAÇÃO
import secaoRoutes from "./routes/secaoRoutes.js"; // ✅ v94 — SECÇÕES (Ciências/Letras) DENTRO DE UMA CLASSE
import renewalRoutes from "./routes/renewalRoutes.js";
import attendanceRoutes from "./routes/attendanceRoutes.js"; // ✅ PRESENÇA / FREQUÊNCIA
import notificationRoutes from "./routes/notificationRoutes.js"; // ✅ NOTIFICAÇÕES
import funcionarioRoutes from "./routes/funcionarioRoutes.js"; // ✅ FUNCIONÁRIOS
import schoolProfileRoutes from "./routes/schoolProfileRoutes.js"; // ✅ PERFIL DA ESCOLA (CONFIGURAÇÕES)
import horarioRoutes from "./routes/horarioRoutes.js"; // ✅ HORÁRIOS (TURNOS, FREQUÊNCIA, GERAÇÃO)
import areaRestritaRoutes from "./routes/areaRestritaRoutes.js"; // ✅ ACESSO RESTRITO POR ÁREA (CÓDIGOS)
import dashboardRoutes from "./routes/dashboardRoutes.js"; // ✅ DASHBOARD INTELIGENTE
import searchRoutes from "./routes/searchRoutes.js"; // ✅ PESQUISA GLOBAL
import bibliotecaRoutes from "./routes/bibliotecaRoutes.js"; // ✅ BIBLIOTECA (MATERIAIS POR CLASSE)
import situacaoEscolarRoutes from "./routes/situacaoEscolarRoutes.js"; // ✅ MOTOR DE SITUAÇÃO ESCOLAR
import perfil360Routes from "./routes/perfil360Routes.js"; // ✅ PERFIL 360°: DOCUMENTOS E COMUNICAÇÃO DO ALUNO
import academicYearRoutes from "./routes/academicYearRoutes.js"; // ✅ ANO LETIVO (academic_years)
import reportBuilderRoutes from "./routes/reportBuilderRoutes.js"; // ✅ MOTOR DE RELATÓRIOS CONFIGURÁVEL (REPORT BUILDER)
import insightsRoutes from "./routes/insightsRoutes.js"; // ✅ FALCON INSIGHTS (Central de Inteligência da Escola)
import authTeacherRoutes from "./routes/authTeacherRoutes.js"; // ✅ v80 — LOGIN DA ÁREA DO PROFESSOR
import professorPortalRoutes from "./routes/professorPortalRoutes.js"; // ✅ v80 — ÁREA DO PROFESSOR (DADOS PRÓPRIOS)
import authStudentRoutes from "./routes/authStudentRoutes.js"; // ✅ v82 — LOGIN DA ÁREA DO ALUNO
import studentPortalRoutes from "./routes/studentPortalRoutes.js"; // ✅ v82 — ÁREA DO ALUNO (DADOS PRÓPRIOS)
import comunicacaoRoutes from "./routes/comunicacaoRoutes.js"; // ✅ v109 — CENTRAL DE COMUNICAÇÃO (WHATSAPP EM MASSA)
import permissaoRoutes from "./routes/permissaoRoutes.js"; // ✅ v123 — GESTÃO DE PERMISSÕES GRANULARES POR PERFIL
import pautaFrequenciaRoutes from "./routes/pautaFrequenciaRoutes.js"; // ✅ v137 — PAUTA DE FREQUÊNCIA E RESULTADOS
import pautaExameRoutes from "./routes/pautaExameRoutes.js"; // ✅ v150 — PAUTA DE EXAME POR JÚRI (NC/NE/NF)
import superAdminRoutes from "./routes/superAdminRoutes.js";

// Importar controllers de tarefas agendadas
import { checkOverduePayments } from "./controllers/paymentController.js";
import { checkRenewalReminders, notificarRenovacoesPendentes } from "./controllers/renewalController.js";
import { executarRotinaFinanceiraDiaria } from "./controllers/mensalidades.controller.js";
import { executarGeracaoDeSalariosDiaria, executarGeracaoDeDespesasRecorrentesDiaria } from "./controllers/dashboardController.js";
import { executarAutomacaoDiariaTodasEscolas } from "./services/automationService.js";
import cron from "node-cron";

dotenv.config();

// (A validação de JWT_SECRET agora acontece em ./config/jwt.js, importado
// acima — se faltar, o processo já terá saído antes de chegar aqui.)

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────
// Antes: cors() sem opções aceitava pedidos de QUALQUER origem. Agora só
// aceita a(s) origem(ns) definida(s) em FRONTEND_URL (separadas por vírgula,
// para suportar ex.: domínio de produção + preview). Em dev, cai para a
// porta padrão do Vite.
const origensPermitidas = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Pedidos sem 'origin' (ex.: Postman, health checks server-to-server)
    // continuam permitidos — só browsers enviam este header para bloquear.
    if (!origin || origensPermitidas.includes(origin)) return callback(null, true);
    console.warn(`[SECURITY] CORS bloqueou origem não autorizada: ${origin}`);
    return callback(new Error("Não autorizado pelo CORS"));
  },
  credentials: true,
}));

// Middleware
app.use(helmet());
app.use(express.json());
app.use("/api", apiLimiter); // 🔒 v59: baseline anti-abuso, ver middleware/rateLimiter.js

// Ficheiros estáticos da Biblioteca (livros, fichas, etc. enviados pela escola)
// e documentos de alunos/professores/funcionários (BI, certidões, contratos).
// 🔒 v59: antes servido sem nenhuma autenticação — qualquer pessoa com a URL
// acedia. Agora exige sessão válida (ver verifyTokenUploads).
app.use("/uploads", verifyTokenUploads, express.static(path.join(__dirname, "uploads")));

// ✅ ROTA DE TESTE PÚBLICA
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "Servidor está funcionando" });
});

// Rotas
app.use("/api", authRoutes);
// ⚠️ schoolRoutes, adminRoutes, paymentRoutes, userRoutes e reportRoutes
// protegem TODAS as suas rotas com verifyToken sem restrição de path
// (a exigência extra de verifySuperAdmin foi removida destes ficheiros
// para que a área do administrador volte a funcionar como na v32 — só é
// preciso sessão válida, já não é preciso ser super administrador). Se
// montados no prefixo genérico "/api" isso bloquearia
// qualquer outro pedido a /api/* (ex: /api/school-admin/login) que ainda
// não tivesse sido respondido por um router anterior, com "Token não
// fornecido" — mesmo sem nenhuma rota destes ficheiros coincidir com o
// pedido. Por isso cada um destes vai agora no seu próprio prefixo (os
// caminhos finais das rotas ficam exatamente iguais aos de antes).
app.use("/api/schools", schoolRoutes);
app.use("/api/admins", adminRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/super-admin", superAdminRoutes);
app.use("/api", settingsRoutes);
app.use("/api/school-admin", authSchoolAdminRoutes);
// v80 — login da Área do Professor, mesmo padrão do login do admin da
// escola: prefixo próprio (não "/api" genérico) para não ser bloqueado
// pelos routers que exigem verifyToken sem restrição de path, e para o
// pedido de login em si não precisar de sessão nenhuma (é aqui que ela
// começa a existir).
app.use("/api/teacher", authTeacherRoutes);
app.use("/api/professor", professorPortalRoutes); // ✅ v80 — ÁREA DO PROFESSOR (dados próprios: perfil, turmas, horário)
app.use("/api/student", authStudentRoutes); // ✅ v82 — LOGIN DA ÁREA DO ALUNO
app.use("/api/aluno", studentPortalRoutes); // ✅ v82 — ÁREA DO ALUNO (dados próprios: perfil, boletim, faltas, horário, biblioteca, mensalidades)
app.use("/api", mensalidadesRoutes);
app.use("/api", studentRoutes); // ✅ REGISTRAR ROTAS DE ALUNOS
app.use("/api", turmaRoutes);
app.use("/api", teacherRoutes);
app.use("/api", disciplinaRoutes);
app.use("/api", salaRoutes);
app.use("/api", gradeRoutes);
app.use("/api", curriculoRoutes); // ✅ REGISTRAR ROTAS DE CURRÍCULO
app.use("/api", secaoRoutes); // ✅ v94 — REGISTRAR ROTAS DE SECÇÕES
app.use("/api", renewalRoutes);
app.use("/api", attendanceRoutes); // ✅ REGISTRAR ROTAS DE PRESENÇA/FREQUÊNCIA
app.use("/api", notificationRoutes); // ✅ REGISTRAR ROTAS DE NOTIFICAÇÕES
app.use("/api", funcionarioRoutes); // ✅ REGISTRAR ROTAS DE FUNCIONÁRIOS
app.use("/api", schoolProfileRoutes); // ✅ REGISTRAR ROTAS DE PERFIL DA ESCOLA
app.use("/api", horarioRoutes); // ✅ REGISTRAR ROTAS DE HORÁRIOS
app.use("/api", dashboardRoutes); // ✅ REGISTRAR ROTAS DO DASHBOARD
app.use("/api", searchRoutes); // ✅ REGISTRAR ROTAS DE PESQUISA GLOBAL
app.use("/api", bibliotecaRoutes); // ✅ REGISTRAR ROTAS DA BIBLIOTECA
app.use("/api", situacaoEscolarRoutes); // ✅ REGISTRAR ROTAS DO MOTOR DE SITUAÇÃO ESCOLAR
app.use("/api", perfil360Routes); // ✅ REGISTRAR ROTAS DO PERFIL 360° (DOCUMENTOS E COMUNICAÇÃO)
app.use("/api", comunicacaoRoutes); // ✅ v109 — CENTRAL DE COMUNICAÇÃO
app.use("/api", permissaoRoutes); // ✅ v123 — GESTÃO DE PERMISSÕES GRANULARES
app.use("/api", pautaFrequenciaRoutes); // ✅ v137 — PAUTA DE FREQUÊNCIA E RESULTADOS
app.use("/api", pautaExameRoutes); // ✅ v150 — PAUTA DE EXAME POR JÚRI (NC/NE/NF)
app.use("/api", academicYearRoutes); // ✅ REGISTRAR ROTAS DO ANO LETIVO
app.use("/api", reportBuilderRoutes); // ✅ REGISTRAR ROTAS DO REPORT BUILDER
app.use("/api", insightsRoutes); // ✅ REGISTRAR ROTAS DO FALCON INSIGHTS
app.use("/api", areaRestritaRoutes); // ✅ REGISTRAR ROTAS DE ACESSO RESTRITO POR ÁREA

// Tarefas agendadas
console.log("[v0] Configurando tarefas agendadas...");

// Verificar pagamentos atrasados todos os dias às 08:00
cron.schedule("0 8 * * *", () => {
  console.log("[v0] Executando verificação de pagamentos atrasados...");
  checkOverduePayments();
});

// Verificar pagamentos atrasados também a cada 6 horas
cron.schedule("0 */6 * * *", () => {
  console.log("[v0] Verificação periódica de pagamentos atrasados...");
  checkOverduePayments();
});

// Verificar prazos de renovação de matrícula todos os dias às 08:00
cron.schedule("0 8 * * *", () => {
  console.log("[v0] Executando verificação de lembretes de renovação de matrícula...");
  checkRenewalReminders();
});

// Notificar quantos alunos ainda não renovaram a matrícula (de acordo com a
// periodicidade configurada) todos os dias às 08:00
cron.schedule("0 8 * * *", () => {
  console.log("[v0] Verificando quantidade de alunos com matrícula por renovar...");
  notificarRenovacoesPendentes();
});

// Rotina financeira diária: gera as cobranças de mensalidade do mês (idempotente)
// e aplica multa + marca como "atrasado" quem passou do prazo configurado pelo admin
cron.schedule("0 6 * * *", () => {
  console.log("[v0] Executando rotina financeira diária (cobranças + multas por atraso)...");
  executarRotinaFinanceiraDiaria();
});

// Geração da mensalidade do mês logo no dia 1, à meia-noite e cinco — garante
// que a cobrança de cada aluno fica lançada assim que o mês começa. A rotina
// diária das 06:00 acima continua a correr todos os dias como rede de
// segurança (apanha alunos matriculados a meio do mês e reaplica as multas),
// mas a criação da mensalidade em si só acontece UMA VEZ por aluno por mês —
// graças à verificação de idempotência em gerarCobrancasDoMesParaEscola.
cron.schedule("5 0 1 * *", () => {
  console.log("[v0] Executando geração da mensalidade do novo mês (dia 1)...");
  executarRotinaFinanceiraDiaria();
});

// Folha salarial como despesa: o salário de professores/funcionários sai uma
// vez por mês, por isso é lançado automaticamente na aba Despesas (categoria
// "Salários"), no último dia do mês — mesma lógica de idempotência das
// mensalidades, corre todos os dias mas só cria uma despesa por pessoa/mês.
cron.schedule("10 6 * * *", () => {
  console.log("[v0] Executando geração da folha salarial do mês (despesas)...");
  executarGeracaoDeSalariosDiaria();
});

// Despesas recorrentes lançadas manualmente pelo admin (ex.: renda, seguro
// anual): mesma lógica de idempotência acima — corre todos os dias mas só
// cria um lançamento por regra ativa por mês, enquanto ela não for cancelada
// ou (no caso de recorrência "temporária") passar do prazo definido.
cron.schedule("15 6 * * *", () => {
  console.log("[v0] Executando geração das despesas recorrentes do mês...");
  executarGeracaoDeDespesasRecorrentesDiaria();
});

// Automação administrativa: avalia todas as regras ativas de cada escola
// (frequência baixa, mensalidade atrasada, notas completas) e cria as
// notificações/lembretes correspondentes. Idempotente — ver automation_disparos
// em services/automationService.js. O admin também pode disparar manualmente
// pelo botão "Executar agora" no bloco de Automação do Falcon Insights.
cron.schedule("0 7 * * *", () => {
  console.log("[v0] Executando avaliação diária das regras de automação administrativa...");
  executarAutomacaoDiariaTodasEscolas();
});

console.log("[v0] Tarefas agendadas configuradas com sucesso");

// ✅ ROTA DE TESTE
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "Servidor está funcionando" });
});

// ✅ 404 EM JSON — evita que o front-end receba HTML (Cannot GET ...) e quebre no
// response.json(), que gerava o erro "Unexpected token '<', <!DOCTYPE...".
// Qualquer rota /api/* que não bateu em nenhum router acima cai aqui.
app.use("/api", (req, res) => {
  console.warn(`[v0] Rota não encontrada: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    message: `Rota não encontrada: ${req.method} ${req.originalUrl}`,
  });
});

// ✅ HANDLER GLOBAL DE ERRO — captura qualquer erro não tratado nos controllers
// e garante uma resposta JSON em vez de uma página de erro em HTML.
app.use((err, req, res, next) => {
  console.error("[v0] Erro não tratado:", err);
  if (res.headersSent) return next(err);
  // 🔒 v59: antes devolvia err.message sempre ao cliente (pode vazar nomes
  // de tabelas/colunas, mensagens de driver do MySQL, caminhos internos).
  // Continua a aparecer em dev (para não atrapalhar o teu trabalho local),
  // mas fica escondido do cliente em produção — o detalhe completo já foi
  // logado no servidor na linha acima.
  const emProducao = process.env.NODE_ENV === "production";
  res.status(500).json({
    success: false,
    message: "Erro interno do servidor",
    ...(emProducao ? {} : { error: err.message }),
  });
});

export default app;
