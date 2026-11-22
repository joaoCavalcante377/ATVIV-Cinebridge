import type { Avaliacao, ProfissionalDados } from '../../domain/types.ts';
import { Profissional } from '../../domain/model.ts';
import { ErroIntegracao, filtrarProfissionais, validarAvaliacao } from '../../application/adaptadores.ts';
import type { AdaptadorProfissional, CriteriosProfissionais } from '../../application/adaptadores.ts';
import { ErroRemoto, FILAS } from '../mensageria.ts';
import type { PortaMensageria } from '../mensageria.ts';

/**
 * ATVIV: o cadastro de profissionais é outro microsserviço (cinebridge-profissionais). Em vez de
 * HTTP direto, a consulta é publicada na fila `consulta-profissionais` e a resposta chega na fila
 * de retorno desta instância. Para o resto do recomendador continua sendo um AdaptadorProfissional.
 */
export class AdaptadorProfissionaisMQ implements AdaptadorProfissional {
  readonly provedor = 'cinebridge-profissionais';
  private mensageria: Pick<PortaMensageria, 'consultar'>;
  private timeoutMs: number;
  constructor(mensageria: Pick<PortaMensageria, 'consultar'>, timeoutMs = 3_000) { this.mensageria = mensageria; this.timeoutMs = timeoutMs; }

  private async consultar<T>(pedido: Record<string, unknown>): Promise<T> {
    try { return await this.mensageria.consultar<T>(FILAS.consultaProfissionais, pedido, this.timeoutMs); }
    catch (erro) {
      if (erro instanceof ErroRemoto) throw new ErroIntegracao(erro.status === 404 ? 'Profissional não encontrado' : erro.message, erro.status);
      throw erro;
    }
  }

  async listarProfissionais(criterios: CriteriosProfissionais = {}): Promise<Profissional[]> {
    const dados = await this.consultar<ProfissionalDados[]>({ operacao: 'listar', criterios });
    if (!Array.isArray(dados)) throw new ErroIntegracao('Resposta inválida do serviço de profissionais');
    // O filtro local garante a mesma semântica de qualquer outra fonte de profissionais.
    return filtrarProfissionais(dados, criterios).map(p => new Profissional(p));
  }

  async detalharProfissional(id: string): Promise<Profissional> {
    return new Profissional(await this.consultar<ProfissionalDados>({ operacao: 'detalhar', id }));
  }

  async registrarAvaliacao(id: string, avaliacao: Avaliacao): Promise<void> {
    validarAvaliacao(avaliacao);
    await this.consultar({ operacao: 'avaliar', id, avaliacao: { nota: avaliacao.nota, comentario: avaliacao.comentario, data: avaliacao.data } });
  }
}
