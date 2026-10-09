import db from '../config/db.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

export const ensureSalasTableExists = async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS salas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      numero VARCHAR(50) NOT NULL,
      descricao TEXT,
      capacidade INT DEFAULT 30,
      equipamentos JSON,
      ativa BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX (school_id),
      UNIQUE KEY unique_school_sala_numero (school_id, numero),
      FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE
    )
  `);
};

export const getSalasBySchool = async (req, res) => {
  const { schoolId } = req.params;

  try {
    await ensureSalasTableExists();

    const salas = await queryAsync(
      `
        SELECT id, school_id, numero, descricao, capacidade, ativa
        FROM salas
        WHERE school_id = ? AND ativa = TRUE
        ORDER BY numero ASC
      `,
      [schoolId]
    );

    res.json({ success: true, data: salas });
  } catch (err) {
    console.error('[v0] Erro ao listar salas:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar salas', error: err.message });
  }
};

export const configureSalasBySchool = async (req, res) => {
  const { schoolId } = req.params;
  const { salas = [] } = req.body;

  if (!Array.isArray(salas)) {
    return res.status(400).json({ success: false, message: 'Lista de salas invalida' });
  }

  const normalizedSalas = salas.map((sala) => ({
    id: sala.id ? Number(sala.id) : null,
    numero: String(sala.numero || '').trim(),
    capacidade: Number.parseInt(sala.capacidade, 10),
  }));

  if (normalizedSalas.some((sala) => !sala.numero || !sala.capacidade || sala.capacidade < 1)) {
    return res.status(400).json({
      success: false,
      message: 'Cada sala deve ter numero e capacidade maior que zero',
    });
  }

  const numeros = normalizedSalas.map((sala) => sala.numero.toLowerCase());
  if (new Set(numeros).size !== numeros.length) {
    return res.status(400).json({ success: false, message: 'Os numeros das salas nao podem repetir' });
  }

  try {
    await ensureSalasTableExists();

    // ── NOTA (v58): db.js passou a usar um pool de conexões em vez de uma
    // conexão única. Numa transação, TODAS as queries têm de correr na MESMA
    // conexão física — por isso, aqui (e só aqui, por ser o único lugar do
    // backend que faz transação real), pedimos uma conexão dedicada ao pool
    // com getConnection() em vez de usar o `db` global. beginTransaction /
    // commit / rollback / query passam a ser chamados nessa conexão.
    db.getConnection((connErr, conexao) => {
      if (connErr) {
        console.error('[v0] Erro ao obter conexao do pool para salas:', connErr);
        return res.status(500).json({ success: false, message: 'Erro ao configurar salas', error: connErr.message });
      }

      const queryNaTransacao = (sql, params = []) => new Promise((resolve, reject) => {
        conexao.query(sql, params, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });

      conexao.beginTransaction(async (transactionErr) => {
        if (transactionErr) {
          conexao.release();
          console.error('[v0] Erro ao iniciar transacao de salas:', transactionErr);
          return res.status(500).json({ success: false, message: 'Erro ao configurar salas', error: transactionErr.message });
        }

        try {
          const keepIds = normalizedSalas.filter((sala) => sala.id).map((sala) => sala.id);

          if (keepIds.length > 0) {
            await queryNaTransacao(
              'UPDATE salas SET ativa = FALSE, updated_at = NOW() WHERE school_id = ? AND id NOT IN (?)',
              [schoolId, keepIds]
            );
          } else {
            await queryNaTransacao('UPDATE salas SET ativa = FALSE, updated_at = NOW() WHERE school_id = ?', [schoolId]);
          }

          for (const sala of normalizedSalas) {
            if (sala.id) {
              await queryNaTransacao(
                `
                  UPDATE salas
                  SET numero = ?, capacidade = ?, ativa = TRUE, updated_at = NOW()
                  WHERE id = ? AND school_id = ?
                `,
                [sala.numero, sala.capacidade, sala.id, schoolId]
              );
            } else {
              const existingSala = await queryNaTransacao(
                'SELECT id FROM salas WHERE school_id = ? AND numero = ? LIMIT 1',
                [schoolId, sala.numero]
              );

              if (existingSala.length > 0) {
                await queryNaTransacao(
                  `
                    UPDATE salas
                    SET capacidade = ?, ativa = TRUE, updated_at = NOW()
                    WHERE id = ? AND school_id = ?
                  `,
                  [sala.capacidade, existingSala[0].id, schoolId]
                );
              } else {
                await queryNaTransacao(
                  `
                    INSERT INTO salas (school_id, numero, capacidade, ativa, created_at, updated_at)
                    VALUES (?, ?, ?, TRUE, NOW(), NOW())
                  `,
                  [schoolId, sala.numero, sala.capacidade]
                );
              }
            }
          }

          conexao.commit((commitErr) => {
            if (commitErr) {
              return conexao.rollback(() => {
                conexao.release();
                console.error('[v0] Erro ao salvar salas:', commitErr);
                res.status(500).json({ success: false, message: 'Erro ao salvar salas', error: commitErr.message });
              });
            }

            conexao.release();
            res.json({ success: true, message: 'Salas configuradas com sucesso' });
          });
        } catch (err) {
          conexao.rollback(() => {
            conexao.release();
            console.error('[v0] Erro ao configurar salas:', err);
            res.status(500).json({ success: false, message: 'Erro ao configurar salas', error: err.message });
          });
        }
      });
    });
  } catch (err) {
    console.error('[v0] Erro ao preparar configuracao de salas:', err);
    res.status(500).json({ success: false, message: 'Erro ao configurar salas', error: err.message });
  }
};
