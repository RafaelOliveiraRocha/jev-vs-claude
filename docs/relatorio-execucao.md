# Jev e Claude Haiku: 50 atendimentos

Experimento local executado em 04/10/2026, com chamadas reais ao Jev 1.13.0 e ao Claude Haiku 4.5 (`claude-haiku-4-5-20251001`). As conversas são sintéticas, em português, da loja fictícia Casa Nimbo. Nenhum atendimento de empresa real foi utilizado.

## Resultado medido

| Medida do lote | Jev | Claude Haiku |
|---|---:|---:|
| Conversas processadas | 50 | 50 |
| Tempo até a última resposta | 9,4237 s | 66,9931 s |
| Mediana por chamada | 351,53 ms | 2.565,69 ms |
| Custo estimado pelo uso informado | US$ 0,015044946 | US$ 0,437478 |
| Concordância nas classificações | 276/300 | 271/300 |
| Concordância nas evidências | 245/300 | 266/300 |
| Respostas estruturalmente válidas | 50/50 | 50/50 |

Neste lote, a razão Claude/Jev foi 7,109 para tempo e 29,078 para custo estimado. O Jev teve maior concordância nas categorias; o Claude, nas mensagens escolhidas como evidência. Isso não estabelece superioridade geral ou qualidade de produção.

O custo adicional da verificação de duas conversas por modelo foi US$ 0,019837612. O total das 104 chamadas de geração desta rodada foi US$ 0,472360558. Foram feitas também duas rodadas de contagem gratuita de tokens, sem geração. Claude consumiu US$ 0,45664 incluindo a verificação, abaixo do teto local de US$ 0,50.

## Método

50 casos selecionados antes das chamadas, cobrindo 20 famílias e 17 trajetórias. Há troca, entrega, reembolso, documentos, cobrança, garantia, cadastro, cancelamento, abandono e retorno. Dois casos adicionais serviram exclusivamente para verificar transporte e formato, sem entrar nos resultados do lote.

Cada modelo recebeu o mesmo diálogo completo e os mesmos critérios: necessidade, dificuldade, último resultado explicitamente relatado pelo cliente, avaliação positiva, avaliação negativa e motivo da transferência. Cada dimensão tem uma seleção independente de mensagem como evidência. Os dois sinais de avaliação são separados da resolução; a satisfação derivada é calculada por código e não acrescenta um sétimo julgamento à métrica.

Concorrência de duas chamadas por fornecedor. Sem repetição automática, cache de respostas ou remoção de casos após os resultados. Claude usou uma ferramenta forçada com 12 campos enumerados, sem solicitação de raciocínio ou explicações, com limite de 384 tokens de saída. Jev usou perguntas `choice` com definições explícitas por categoria. O gabarito e metadados dos cenários ficaram fora dos payloads.

O gabarito foi preparado por revisão semântica assistida por IA antes das chamadas. Alguns campos têm conjuntos estritos de respostas admissíveis, documentados no arquivo. Não é anotação especializada independente, nem medida comprovada de acurácia. A concordância em evidências mede os IDs aceitos por esse gabarito; uma divergência pode exigir revisão de outra mensagem plausível. IDs válidos não garantem evidência semanticamente correta.

Resolução significa o último resultado explicitamente relatado pelo cliente. Uma afirmação do operador não comprova sucesso. Um relato do cliente anterior à última ação pode continuar sendo o último resultado observado; essa classificação não é verificação do estado operacional atual. A ausência de resposta não comprova resolução nem insatisfação.

## Gravação

Captura contínua do Chrome por `Page.startScreencast`, iniciada antes do clique que disparou as APIs. 600 frames originais e 120,2543 segundos de captura. A edição remove somente espera antes do clique e parte da pausa estática final. Todo o processamento e a inspeção permanecem contínuos. Reprodução uniforme em 1,5×, indicada no vídeo; relógios e métricas preservam os tempos reais. Vídeo sem narração e sem áudio.

`recording/manifest.json`, índices de frames e `render-report.json` documentam origem, ações, tempos, edição e métricas. `capture.zip` preserva os pixels decodificados da captura em deltas RGB sem perdas; `compress-capture.py` permite reconstrução. Nenhum progresso ou resposta foi gerado para a filmagem.

## Arquivos

- `dataset.json`, `selection.json`: conversas e seleção congelada.
- `questions.json`, `ground-truth.json`: critérios e gabarito prévio.
- `results.json`, `run-artifacts/`: ledgers, entradas, respostas originais e avaliações normalizadas.
- `token-budget.json`: contagens gratuitas de entrada, hashes e reserva anterior às chamadas.
- `server.mjs`, `benchmark-lib.mjs`, `index.html`: servidor e interface local.
- `record.mjs`, `render-recording.py`, `compress-capture.py`: captura, edição e reconstrução.

O servidor desta rodada ficou em `http://127.0.0.1:43193`, dentro de `/home/rocha/projetos/jev-comparison/reviewed-50` no Pop!_OS. O projeto anterior e seus resultados foram preservados. O ledger bloqueia novo disparo do mesmo lote. Segredos e arquivos `.env` não fazem parte do pacote.

## Tarifas usadas

Jev: US$ 0,042 por milhão de tokens de entrada, saída sem custo, conforme https://docs.typesafe.ai/models.

Claude Haiku 4.5: US$ 1 por milhão de tokens de entrada e US$ 5 por milhão de tokens de saída, conforme https://platform.claude.com/docs/en/about-claude/pricing.

Custos calculados com os tokens efetivamente informados nas respostas, sem conversão cambial ou impostos. São estimativas pelas tarifas públicas, não faturas. Contagem de entrada: endpoint gratuito https://platform.claude.com/docs/en/build-with-claude/token-counting. A reserva acrescentou 256 tokens por chamada e toda a saída permitida; a contagem é uma estimativa, sem garantia matemática do custo faturado.
