# Gestão de Frota — Painel Gerencial

Painel HTML/CSS/JavaScript que lê as abas diárias da planilha `DISPONIBILIDADE - UTILIZAÇÃO.xlsx`, calcula os indicadores por placa única e mantém histórico no navegador.

## Correção solicitada: manutenção + sinistro

O card agora apresenta o **total conjunto de veículos parados por manutenção ou sinistro**, com a abertura logo abaixo:

- **Manutenção:** status que contenham `MANUTENÇÃO`.
- **Sinistro:** status que contenham `SINISTRO`, exceto quando o mesmo status também contém `MANUTENÇÃO`.
- **Total parado:** união dos dois grupos, contando cada veículo uma única vez.

Se aparecer um texto combinado como `MANUTENÇÃO / SINISTRO`, ele entra na categoria Manutenção e no total conjunto, evitando contar a mesma placa duas vezes. O gráfico correspondente mostra Manutenção e Sinistro em barras empilhadas.

A regra original de disponibilidade física permanece: somente Manutenção reduz a disponibilidade física. Sinistro continua reduzindo a capacidade de utilização, mas não altera a fórmula de disponibilidade física. O indicador “Outros motivos” passou a excluir manutenção e sinistro, evitando que os grupos se sobreponham.

## Como executar localmente

1. Extraia a pasta do projeto.
2. Abra o terminal dentro dela.
3. Execute `python -m pip install -r requirements.txt`.
4. Execute `python -m http.server 8000`.
5. Abra `http://localhost:8000` no Chrome ou Edge.
6. Para processar outra planilha localmente, use **Importar planilha** dentro do painel.

Ao abrir o `index.html` diretamente pelo `file://`, a leitura e os gráficos podem funcionar, mas o IndexedDB e a verificação remota têm limitações. Para uso normal, prefira o servidor local.

## Corrigir e ativar a atualização automática no GitHub

### Estrutura obrigatória

Mantenha estes arquivos no diretório raiz do repositório e a planilha em `source/`:

```text
.github/workflows/deploy.yml
index.html
style.css
script.js
js/core.js
scripts/build_public_data.py
requirements.txt
source/DISPONIBILIDADE - UTILIZAÇÃO.xlsx
```

**Nome e caminho da planilha:** `source/DISPONIBILIDADE - UTILIZAÇÃO.xlsx`. Substitua esse arquivo pela versão atualizada, mantendo o mesmo caminho e nome. O workflow também é disparado para alterações em arquivos `.xlsx`/`.xlsm` no repositório, mas o script prioriza esse caminho padrão.

### O que acontece quando você envia uma planilha nova

1. O GitHub Actions identifica o commit que alterou o Excel.
2. Instala `openpyxl` e executa `scripts/build_public_data.py`.
3. O script lê todas as abas `DD.MM`, ignora `LOGISTICS`, calcula cada dia e cria uma nova identificação de versão a partir da planilha e do código.
4. O processo gera `dist/` com a página, arquivos de estilo, scripts e `data/version.json` + `data/initial-summary.json`.
5. Quando a publicação está autorizada, o GitHub Pages recebe a nova versão.
6. O navegador confere a versão ao abrir, ao voltar para a aba e a cada 60 segundos; ao detectar uma versão diferente, busca o resumo atualizado sem usar o cache antigo.

A atualização da planilha **não depende de editar o HTML**. O commit do Excel é o gatilho do workflow.

### Habilitar a publicação

Em **Settings → Pages**, configure **Build and deployment → Source: GitHub Actions**.

Para evitar divulgação operacional sem autorização, o workflow só publica quando uma destas opções estiver habilitada em **Settings → Secrets and variables → Actions → Variables**:

- **Pages realmente privado:** `ENABLE_PRIVATE_PAGES=true` e `PAGES_SITE_VISIBILITY=private`. A visibilidade privada de GitHub Pages depende de GitHub Enterprise Cloud e precisa estar selecionada nas configurações da organização/site; as variáveis não tornam o site privado por si só.
- **Resumo público autorizado:** `ALLOW_PUBLIC_SUMMARY_PAGES=true`. Use somente se a empresa autorizar que os indicadores agregados (por data, base, locadora e status) sejam publicados na internet.

Se nenhuma opção estiver definida, o workflow processa e valida os dados, mas não publica no Pages. Nesse caso, a execução de Actions pode terminar com sucesso, mas o painel online continuará na versão anterior. Isso é intencional para evitar publicação pública não autorizada.

**Nunca coloque token pessoal do GitHub no HTML/JavaScript.** Por padrão, a relação de placas não é publicada. Ela fica disponível apenas depois de importar o Excel diretamente no navegador do usuário.

### Como conferir se atualizou

1. Abra a aba **Actions** do repositório.
2. Entre em `Atualizar e publicar painel de frota`.
3. A execução deve mostrar as etapas **Processar todas as abas e gerar site** e **Validar se os dados foram gerados** como concluídas.
4. Se o deploy não rodar, confira a variável de autorização acima e se Pages está configurado como GitHub Actions.
5. Abra o site e use **Atualizar dados**. O status no topo deve mudar para `DADOS ATUALIZADOS` ou `DADOS SINCRONIZADOS`.

O arquivo `dist/build-info.json` identifica a versão gerada e quantas datas foram processadas.

## Regras e fontes dos indicadores

- Cada aba com nome `DD.MM` é interpretada como um dia; `LOGISTICS` e abas sem data são ignoradas.
- Cabeçalho na linha 2 e registros a partir da linha 3. Colunas são localizadas pelo nome PLACA, BASE, STATUS e LOCADORA, com A/B/C como fallback.
- A placa é o identificador único dentro de cada dia; duplicadas são ignoradas.
- **Disponibilidade física:** Frota total menos Manutenção.
- **Capacidade de utilização:** Frota total menos todos os status indisponíveis.
- Status desconhecidos são indisponíveis até classificação na configuração do painel.
- `maintenanceSinistroTotal` é o total de placas cujo status contém Manutenção ou Sinistro, com união sem dupla contagem.
- Histórico e detalhes locais são persistidos no IndexedDB do navegador.

## Dados utilizados nesta versão

A planilha inicial incluída no pacote tem 26 abas diárias de 01/10/2026 a 06/11/2026. Na posição de 06/11/2026 (aba `06.11`), a validação encontrou:

| Indicador | Resultado |
|---|---:|
| Frota total | 374 |
| Manutenção | 37 |
| Sinistro | 1 |
| Total manutenção + sinistro | 38 |
| Disponibilidade física | 337 (90,11%) |
| Indisponíveis para operação | 84 |
| Capacidade de utilização | 290 (77,54%) |
| Outros motivos, excluindo manutenção e sinistro | 46 |

Esses números são a validação da planilha anexada, não valores fixos do sistema.

## Testes

- `npm test` executa testes das regras de separação, status desconhecidos e virada de ano.
- `python scripts/build_public_data.py` executa a leitura real do Excel e gera o site em `dist/`.
