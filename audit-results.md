# Auditoria breve dos resultados reais — 50 atendimentos

Os números favorecem Jev em custo e tempo e Claude na seleção de evidências. A diferença de categorias é pequena e não sustenta uma conclusão geral de superioridade: Jev acertou cinco campos de categoria a mais neste conjunto; Claude acertou 21 campos de evidência a mais contra o gabarito congelado.

Esta auditoria leu `results.json`, o diálogo efetivo em `dataset.json`, `questions.json` atomic-v1 e o gabarito local congelado. Não houve chamadas de API, edição de gabarito/resultados ou recálculo com uma referência modificada. Os números abaixo são os resultados já registrados da fase benchmark; o preflight está excluído. As discordâncias defensáveis listadas depois são observações de auditoria, não novos pontos concedidos.

| Medida do benchmark | Jev 1.13.0 | Claude Haiku 4.5 |
|---|---:|---:|
| Categorias contra referência | 276/300 — 92,0% | 271/300 — 90,3% |
| Evidências contra referência | 245/300 — 81,7% | 266/300 — 88,7% |
| Custo estimado registrado | US$ 0,015045 | US$ 0,437478 |
| Tempo do lote, concorrência 2 | 9,424 s | 66,993 s |
| Respostas estruturalmente válidas | 50/50 | 50/50 |

Na configuração executada, Claude custou aproximadamente 29,1 vezes o Jev, e o lote Jev terminou aproximadamente 7,1 vezes mais rápido. A economia estimada do Jev foi 96,6%. Custos derivam do uso de tokens devolvido pelas APIs e das tarifas configuradas no registro; são estimativas, não fatura. Tempo é despacho do lote até a última resposta recebida, sob concorrência dois, sem retries nem respostas reaproveitadas; não é uma medida isolada da velocidade interna de cada modelo.

## Onde se concentram as diferenças

Cada célula representa acertos contra a referência congelada, em 50 campos de cada tipo.

| Faceta | Categorias Jev / Claude | Evidências Jev / Claude |
|---|---:|---:|
| Necessidade | 50 / 49 | 49 / 49 |
| Dificuldade | 38 / 45 | 23 / 44 |
| Resolução | 46 / 43 | 38 / 39 |
| Avaliação positiva | 50 / 50 | 50 / 50 |
| Avaliação negativa | 50 / 45 | 50 / 45 |
| Motivo da transferência | 42 / 39 | 35 / 39 |

A vantagem do Claude em evidências concentra-se na dificuldade: 44 contra 23. Jev teve mais concordância em avaliação negativa, resolução e motivo da transferência. Assim, um percentual único que misture categorias e evidências depende de uma ponderação de objetivos que este teste não definiu. Validade estrutural também não equivale a correção semântica.

## Três erros semânticos sólidos do Jev

| Caso e campo | Resposta Jev | Referência | Por que o erro é sustentado pelo diálogo |
|---|---|---|---|
| CN-SIM-0023 — `difficulty` | `none` | `other` ou `product_issue` | M002 afirma que o pedido consta entregue, mas o cliente não recebeu o tênis. M006 acrescenta assinatura desconhecida. Há um obstáculo explícito; `none` é incompatível com a conversa. |
| CN-SIM-0034 — `difficulty` | `delay` | `product_issue` | M002 diz “O ventilador não liga mais.” Não há espera ou prazo declarado que substitua esse defeito como obstáculo primário. O silêncio posterior não cria atraso. |
| CN-SIM-0035 — `transfer_reason` | `access_restriction` | `not_transferred` | Existe restrição de acesso, mas nenhum encaminhamento anunciado ou realizado. M009 diz apenas que a equipe retirou o bloqueio; ação interna de uma equipe não comprova transferência do atendimento. |

Também há erros inequívocos de evidência: no caso 0012 Jev escolhe M005, uma pergunta sobre o código do pedido, como prova de avaria; no caso 0007 escolhe M019, “tá, era isso mesmo”, como confirmação de resolução, apesar da confirmação concreta em M017.

## Três erros semânticos sólidos do Claude

| Caso e campo | Resposta Claude | Referência | Por que o erro é sustentado pelo diálogo |
|---|---|---|---|
| CN-SIM-0028 — `transfer_reason` | `missing_capability` | `process_failure` | M013 explicita encaminhamento para “refazer o processamento do reembolso que falhou”. A razão declarada é falha do processo; nenhuma falta de capacidade do agente é afirmada. |
| CN-SIM-0030 — `negative_evaluation` | `present` | `absent` | M008 e M017–M018 relatam pedido ativo, ausência de protocolo e erro na página. São falhas factuais, sem julgamento negativo explícito da experiência. Os critérios excluem inferir avaliação a partir de falha ou pendência. |
| CN-SIM-0044 — `negative_evaluation` | `present` | `absent` | M016–M017 relatam autorização ainda exigida e impossibilidade de registrar a troca. Não há crítica avaliativa explícita. A pendência foi convertida indevidamente em avaliação negativa. |

Esses exemplos não tornam todas as discordâncias com a referência erros inequívocos.

## Discordâncias defensáveis e limites do gabarito

Algumas escolhas de evidência fora dos conjuntos aceitos continuam semanticamente defensáveis:

- Jev, dificuldade nos casos 0002/M019, 0028/M022 e 0037/M016: “continua aguardando a próxima etapa” afirma espera explicitamente. Os critérios permitem mensagens de agente e incluem resposta ou processamento não concluído em `delay`. Essas âncoras foram omitidas dos conjuntos congelados, embora sejam defensáveis para a categoria de atraso.
- Jev, dificuldade em 0045/M013: o reagendamento registra expressamente a falta do transportador, o que apoia a coleta malsucedida no contexto do prazo vencido. A preferência da referência por mensagens anteriores não torna esse ID inequivocamente inválido.
- Jev e Claude, dificuldade em 0027/M009: o agente afirma não conseguir identificar o documento correto. Isso pode apoiar a dificuldade de esclarecimento; a referência admite somente a afirmação posterior do cliente. O enunciado da evidência de dificuldade não exige a última mensagem.
- Jev, necessidade em 0033/M003: “só que o fone não estava no pacote” explicita o item faltante no contexto do pedido incompleto. É uma âncora defensável para a necessidade de entrega, embora venha em fragmento e esteja fora do conjunto aceito.

Há também disputas de categoria que devem permanecer como ambiguidades, sem mudar o placar: em 0036, Claude escolhe `billing_dispute` quando a fatura difere do desconto anunciado, enquanto a referência privilegia a falta de explicação como `unclear_guidance`; em 0045, `delivery` versus `exchange` depende de considerar a coleta imediata ou a troca como pedido primário. Em 0034, a resolução `unresolved` escolhida pelo Claude é defensável pela afirmação de que o ventilador não liga, embora a referência classifique `insufficient` por não haver resultado explícito do registro da garantia. A evidência que Claude escolheu nesse campo, M004, é apenas o número do pedido e continua inadequada.

Por outro lado, M020 de 0006 (“baixar a nota fiscal do pedido.”), escolhido pelos dois provedores como evidência de resolução, não contém sozinho uma afirmação de sucesso ou insucesso. A mensagem anterior contém a negação. O erro contra uma exigência de evidência atômica é sustentado; um produto que permita intervalos de mensagens poderia representar essa prova de outra forma.

O conjunto tem 50 conversas sintéticas selecionadas de um gerador com famílias e trajetórias recorrentes. Seus 300 campos por tipo não são 300 observações estatisticamente independentes. Houve uma execução por conversa e provedor, sem múltiplas sementes ou adjudicação humana cega independente. A revisão prévia evitou adaptar o gabarito aos outputs, mas não garantiu exaustividade de todos os IDs válidos nem removeu toda ambiguidade de primazia. Não há intervalo de confiança ou teste de significância que autorize uma classificação geral dos modelos.

Formulação recomendada: “Neste teste sintético de 50 atendimentos, Jev entregou custo estimado cerca de 29 vezes menor e concluiu o lote cerca de sete vezes mais rápido. A concordância de categorias foi próxima, com pequena vantagem do Jev; Claude teve maior concordância na seleção de evidências, sobretudo de dificuldade. Os resultados medem concordância com uma referência local revisada e não comprovam acurácia em produção.”
