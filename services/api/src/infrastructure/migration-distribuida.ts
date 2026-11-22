import type { MigrationInterface, QueryRunner } from 'typeorm';
import { nomeTabela } from './migration.ts';

/**
 * ATVIV: os profissionais pertencem ao serviço cinebridge-profissionais e ao banco profissionais-db.
 * Membros e convites guardam apenas o identificador, sem chave estrangeira para uma tabela local
 * (o mesmo vale para profissionais vindos de fontes externas, como `linkedin:123`).
 */
export class ProfissionaisDistribuidos1796000000000 implements MigrationInterface {
  name = 'ProfissionaisDistribuidos1796000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const tabela = (nome: string) => nomeTabela((queryRunner.connection.options as { schema?: string }).schema, nome);
    await queryRunner.query(`ALTER TABLE ${tabela('membros_equipe')} DROP CONSTRAINT IF EXISTS "membros_equipe_profissionalId_fkey"`);
    await queryRunner.query(`ALTER TABLE ${tabela('convites')} DROP CONSTRAINT IF EXISTS "convites_profissionalId_fkey"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const tabela = (nome: string) => nomeTabela((queryRunner.connection.options as { schema?: string }).schema, nome);
    // NOT VALID: registros criados sem a tabela local de profissionais não impedem a reversão.
    await queryRunner.query(`ALTER TABLE ${tabela('membros_equipe')} ADD CONSTRAINT "membros_equipe_profissionalId_fkey"
      FOREIGN KEY ("profissionalId") REFERENCES ${tabela('profissionais')}(id) NOT VALID`);
    await queryRunner.query(`ALTER TABLE ${tabela('convites')} ADD CONSTRAINT "convites_profissionalId_fkey"
      FOREIGN KEY ("profissionalId") REFERENCES ${tabela('profissionais')}(id) NOT VALID`);
  }
}
