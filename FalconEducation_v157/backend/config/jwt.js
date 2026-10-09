import dotenv from 'dotenv';
dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// FONTE ÚNICA DO SEGREDO JWT
// ─────────────────────────────────────────────────────────────────────────────
// Antes, cada ficheiro tinha o seu próprio `process.env.JWT_SECRET || "algo-fixo"`.
// Isso é seguro enquanto o .env estiver correto, mas se JWT_SECRET desaparecer em
// produção (variável apagada, deploy mal configurado, etc.), o servidor passa a
// assinar e validar tokens com uma string pública e previsível — qualquer pessoa
// pode forjar um token de admin.
//
// Por isso, agora: falha alto e visível no arranque. Sem fallback funcional.
// ═══════════════════════════════════════════════════════════════════════════════
if (!process.env.JWT_SECRET) {
  console.error(
    '❌ [SECURITY] JWT_SECRET não está definido no .env. O servidor não arranca ' +
    'sem um segredo de assinatura de tokens — defina JWT_SECRET antes de continuar.'
  );
  process.exit(1);
}

export const JWT_SECRET = process.env.JWT_SECRET;
