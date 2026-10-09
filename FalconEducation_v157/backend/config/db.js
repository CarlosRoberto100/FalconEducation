import mysql from "mysql2";
import dotenv from "dotenv";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// POOL DE CONEXÕES (v58 — antes era uma única mysql.createConnection)
// ─────────────────────────────────────────────────────────────────────────────
// Com uma única conexão, qualquer queda dela (timeout do MySQL, "MySQL server
// has gone away", reinício do servidor de BD, rede instável) derrubava TODAS
// as queries seguintes até reiniciar o processo Node inteiro — não havia
// reconexão automática.
//
// Um pool mantém várias conexões abertas, reaproveitadas por pedido, e
// substitui sozinho qualquer conexão que caia. Para o resto do backend isto
// é transparente: pool.query(sql, params, callback) tem a mesma assinatura
// que connection.query(sql, params, callback), usada em todo o lado via
// queryAsync() em cada controller.
//
// ⚠️ Única exceção: código que faz transação real (beginTransaction/commit/
// rollback) precisa de pedir uma conexão dedicada com db.getConnection(),
// para garantir que todas as queries da transação correm na mesma ligação
// física — ver controllers/salaController.js para o padrão a seguir.
// ═══════════════════════════════════════════════════════════════════════════════
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Verificação de arranque: falha alto e cedo se a base de dados estiver
// inacessível (credenciais erradas, MySQL parado, etc.), em vez de deixar o
// primeiro pedido de um utilizador real descobrir isso silenciosamente.
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Erro ao conectar ao banco de dados:", err);
    process.exit(1);
  }
  console.log("✅ Conectado ao banco de dados (pool de conexões)!");
  connection.release();
});

export default db;
