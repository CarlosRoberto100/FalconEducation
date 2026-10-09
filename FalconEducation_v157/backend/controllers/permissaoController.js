import {
  MODULOS,
  CATEGORIAS_MODULO,
  listarPerfis,
  obterMatrizDoPerfil,
  atualizarPermissao,
  criarPerfil,
  editarPerfil,
  excluirPerfil,
  listarUtilizadoresDaEscola,
  atribuirPerfilAoUtilizador,
  obterHistorico,
  obterMinhasPermissoes,
} from '../services/permissionService.js';

const tratarErro = (res, error, mensagemPadrao) => {
  console.error('[permissaoController]', error);
  const status = error.status || 500;
  res.status(status).json({ success: false, message: error.status ? error.message : mensagemPadrao });
};

export const getModulos = (req, res) => {
  res.json({ success: true, modulos: MODULOS, categorias: CATEGORIAS_MODULO });
};

export const getPerfis = async (req, res) => {
  try {
    const perfis = await listarPerfis(req.params.schoolId);
    res.json({ success: true, perfis });
  } catch (error) {
    tratarErro(res, error, 'Erro ao listar perfis.');
  }
};

export const postPerfil = async (req, res) => {
  try {
    const { nome, descricao, cor } = req.body;
    const perfil = await criarPerfil({
      schoolId: req.params.schoolId,
      nome, descricao, cor,
      adminId: req.user?.id,
      adminNome: req.user?.nome,
    });
    res.status(201).json({ success: true, perfil });
  } catch (error) {
    tratarErro(res, error, 'Erro ao criar perfil.');
  }
};

export const putPerfil = async (req, res) => {
  try {
    const { nome, descricao, cor } = req.body;
    const perfil = await editarPerfil({
      schoolId: req.params.schoolId,
      perfilId: req.params.perfilId,
      nome, descricao, cor,
      adminId: req.user?.id,
      adminNome: req.user?.nome,
    });
    res.json({ success: true, perfil });
  } catch (error) {
    tratarErro(res, error, 'Erro ao editar perfil.');
  }
};

export const deletePerfil = async (req, res) => {
  try {
    await excluirPerfil({
      schoolId: req.params.schoolId,
      perfilId: req.params.perfilId,
      adminId: req.user?.id,
      adminNome: req.user?.nome,
    });
    res.json({ success: true });
  } catch (error) {
    tratarErro(res, error, 'Erro ao excluir perfil.');
  }
};

export const getMatriz = async (req, res) => {
  try {
    const matriz = await obterMatrizDoPerfil(req.params.perfilId);
    res.json({ success: true, matriz });
  } catch (error) {
    tratarErro(res, error, 'Erro ao carregar matriz de permissões.');
  }
};

export const putMatriz = async (req, res) => {
  try {
    const { modulo, acao, valor } = req.body;
    const resultado = await atualizarPermissao({
      schoolId: req.params.schoolId,
      perfilId: req.params.perfilId,
      modulo, acao, valor,
      adminId: req.user?.id,
      adminNome: req.user?.nome,
    });
    res.json({ success: true, ...resultado });
  } catch (error) {
    tratarErro(res, error, 'Erro ao atualizar permissão.');
  }
};

export const getUtilizadores = async (req, res) => {
  try {
    const utilizadores = await listarUtilizadoresDaEscola(req.params.schoolId);
    res.json({ success: true, utilizadores });
  } catch (error) {
    tratarErro(res, error, 'Erro ao listar utilizadores.');
  }
};

export const putUtilizadorPerfil = async (req, res) => {
  try {
    const { perfil_id } = req.body;
    const resultado = await atribuirPerfilAoUtilizador({
      schoolId: req.params.schoolId,
      contaAdminId: req.params.contaAdminId,
      perfilId: perfil_id === null || perfil_id === undefined || perfil_id === '' ? null : Number(perfil_id),
      adminId: req.user?.id,
      adminNome: req.user?.nome,
    });
    res.json({ success: true, ...resultado });
  } catch (error) {
    tratarErro(res, error, 'Erro ao atribuir perfil.');
  }
};

export const getHistorico = async (req, res) => {
  try {
    const historico = await obterHistorico(req.params.schoolId, req.query.limite);
    res.json({ success: true, historico });
  } catch (error) {
    tratarErro(res, error, 'Erro ao carregar histórico.');
  }
};

export const getMinhasPermissoes = async (req, res) => {
  try {
    // Superadmin e outros papéis (professor/aluno, cujos portais têm as
    // suas próprias restrições) recebem sempre "acesso total" aqui — este
    // endpoint serve para o painel do ADMIN DA ESCOLA adaptar a sua própria
    // interface, não é usado pelos outros portais.
    if (req.user.role !== 'schooladmin') {
      return res.json({ success: true, acesso_total: true, permissoes: {} });
    }
    const resultado = await obterMinhasPermissoes({
      schoolId: req.params.schoolId,
      contaAdminId: req.user.id,
    });
    res.json({ success: true, ...resultado });
  } catch (error) {
    tratarErro(res, error, 'Erro ao carregar as suas permissões.');
  }
};
