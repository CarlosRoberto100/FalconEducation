import { temPermissao } from '../services/permissionService.js';

// ═══════════════════════════════════════════════════════════════════════════════
// v123 — requirePermission(modulo, acao)
// ─────────────────────────────────────────────────────────────────────────────
// Middleware de uso opcional, para acrescentar por cima de `verifyToken` +
// `verifySchoolAccess` em rotas onde se queira aplicar a matriz de permissões
// granulares. Deve ser usado DEPOIS desses dois (precisa de `req.user` e
// `req.params.schoolId` já validados).
//
// Comportamento:
//   - `role === 'superadmin'` → sempre permitido (gestão da plataforma).
//   - qualquer papel que não seja 'schooladmin' (professor, aluno) → sempre
//     permitido aqui; esses portais já têm os seus próprios middlewares de
//     restrição (verifyTeacherRole, verifyStudentRole) que limitam o acesso
//     aos próprios dados, o que é uma barreira diferente e já suficiente.
//   - 'schooladmin' → consulta `temPermissao()`. Uma conta sem perfil
//     atribuído (perfil_id NULL) continua com acesso total — é o
//     comportamento de hoje para todas as contas existentes.
// ═══════════════════════════════════════════════════════════════════════════════
export const requirePermission = (modulo, acao) => async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Sessão inválida.' });
    }

    if (req.user.role === 'superadmin' || req.user.role !== 'schooladmin') {
      return next();
    }

    const schoolId = req.params.schoolId || req.user.school_id;
    const permitido = await temPermissao({
      schoolId,
      contaAdminId: req.user.id,
      modulo,
      acao,
    });

    if (!permitido) {
      return res.status(403).json({
        success: false,
        message: `Acesso negado. O seu perfil não tem permissão para "${acao}" em "${modulo}".`,
      });
    }

    next();
  } catch (error) {
    console.error('[permissionMiddleware] Erro ao verificar permissão:', error);
    // Em caso de erro inesperado a validar a permissão (ex.: falha pontual de
    // BD), falha de forma SEGURA (nega o acesso) em vez de deixar passar.
    res.status(500).json({ success: false, message: 'Erro ao verificar permissões.' });
  }
};
