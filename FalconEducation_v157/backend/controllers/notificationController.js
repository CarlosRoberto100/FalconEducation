import {
  criarNotificacao, notificarEscola, listarNotificacoes, marcarComoLida, marcarTodasComoLidas,
} from '../services/notificationService.js';

// v121 — este ficheiro deixou de ter lógica própria de acesso à base de
// dados; é só a camada HTTP (req/res) por cima de services/notificationService.js,
// que agora é a ÚNICA fonte de verdade para ler/escrever notificações. Ver o
// cabeçalho desse ficheiro para o histórico da unificação.
//
// `criarNotificacao` é re-exportada por compatibilidade — todos os outros
// controllers que já a importavam daqui continuam a funcionar sem alterações.
export { criarNotificacao, notificarEscola };

/**
 * GET: Lista as notificações mais recentes da escola (ordem decrescente).
 * Aceita ?target_role=professor|aluno&user_id=123 para um portal que não
 * seja o do admin pedir só as suas — omitido, devolve as do admin (sino
 * histórico do dashboard).
 */
export const getNotifications = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { limit, target_role: targetRole, user_id: targetUserId } = req.query;
    const { notificacoes, naoLidas } = await listarNotificacoes(schoolId, { targetRole, targetUserId, limit });
    res.json({ success: true, data: notificacoes, nao_lidas: naoLidas });
  } catch (err) {
    console.error('[v0] Erro ao listar notificações:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar notificações', error: err.message });
  }
};

/**
 * PUT: Marca uma notificação como lida
 */
export const markNotificationRead = async (req, res) => {
  try {
    const { schoolId, notificationId } = req.params;
    await marcarComoLida(schoolId, notificationId);
    res.json({ success: true, message: 'Notificação marcada como lida' });
  } catch (err) {
    console.error('[v0] Erro ao marcar notificação como lida:', err);
    res.status(500).json({ success: false, message: 'Erro ao marcar notificação como lida', error: err.message });
  }
};

/**
 * PUT: Marca todas as notificações da escola (do público-alvo indicado, ou
 * as do admin por omissão) como lidas
 */
export const markAllNotificationsRead = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { target_role: targetRole, user_id: targetUserId } = req.query;
    await marcarTodasComoLidas(schoolId, { targetRole, targetUserId });
    res.json({ success: true, message: 'Todas as notificações foram marcadas como lidas' });
  } catch (err) {
    console.error('[v0] Erro ao marcar notificações como lidas:', err);
    res.status(500).json({ success: false, message: 'Erro ao marcar notificações como lidas', error: err.message });
  }
};
