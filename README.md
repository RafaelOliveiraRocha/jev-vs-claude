# Jev × Claude Haiku: classificação de atendimentos

Experimento de Rafael Oliveira Rocha para comparar custo estimado, tempo e concordância com uma referência na extração de informações de conversas em português.

O problema: identificar necessidade, dificuldade, resolução, avaliações positiva e negativa e motivo da transferência — e apontar a mensagem que sustenta cada classificação. A comparação usa Jev 1.13.0 e Claude Haiku 4.5 (`claude-haiku-4-5-20251001`).

Os dados são sintéticos, da loja fictícia Casa Nimbo. As chamadas às APIs foram reais, em **4 de outubro de 2026, horário de Brasília**; os registros em UTC têm a data de 5 de outubro.

## Resultados registrados

| Medida nas 50 conversas | Jev | Claude Haiku |
|---|---:|---:|
| Tempo até a última resposta do lote | 9,424 s | 66,993 s |
| Mediana por chamada | 351,53 ms | 2.565,69 ms |
| Custo estimado | US$ 0,015045 | US$ 0,437478 |
| Concordância de categorias | 276/300 | 271/300 |
| Concordância de evidências | 245/300 | 266/300 |
| Respostas estruturalmente válidas | 50/50 | 50/50 |

Neste lote, Jev teve custo estimado cerca de 29 vezes menor e terminou cerca de sete vezes mais rápido. Claude apresentou maior concordância na seleção de evidências. A diferença de categorias foi pequena. Esses resultados descrevem esta configuração e este conjunto sintético; não estabelecem superioridade geral dos modelos.

Leia a [auditoria dos resultados](audit-results.md), que discute erros concretos, respostas defensáveis e limitações da referência. Os custos usam os tokens informados pelas APIs e as tarifas registradas na execução; não são uma fatura nem uma consulta a preços atuais.

## Dados disponíveis

| Arquivo | Conteúdo |
|---|---|
| [data/jev-1000-dialogos.csv](data/jev-1000-dialogos.csv) | 1.000 conversas geradas, com 17.686 mensagens; uma mensagem por linha |
| [dataset.json](dataset.json) | 50 conversas medidas e duas de verificação prévia |
| [selection.json](selection.json) | Critérios, cobertura e seleção congelada antes das chamadas |
| [questions.json](questions.json) | Definições das seis dimensões e critérios de evidência |
| [ground-truth.json](ground-truth.json) | Referência preparada antes da execução |
| [results.json](results.json) | 100 respostas do lote e quatro de verificação prévia |
| [run-artifacts/](run-artifacts/) | Entradas, respostas originais, avaliações e registros das execuções |

As 1.000 conversas compõem o conjunto gerado. **Somente 50 entraram no resultado comparativo.** As outras duas conversas foram usadas para verificar transporte e formato. As mensagens das 52 conversas selecionadas correspondem às mensagens do CSV.

O gabarito teve revisão semântica assistida por IA; não é anotação especializada independente. Há ambiguidades e evidências plausíveis fora dos IDs aceitos. Os 300 campos de cada tipo não são 300 observações independentes. Houve uma execução por conversa e provedor.

## Consultar localmente

Requisito: Node.js 22 ou superior. A conferência deste pacote foi feita com Node.js 24.19.0. Não há dependências npm para consultar a interface ou os resultados.

```bash
npm start
```

Abra `http://127.0.0.1:43193`. A interface carrega as respostas já registradas. Sem chaves e sem habilitação explícita, o servidor não dispara chamadas às APIs. Os registros históricos também bloqueiam o redisparo do mesmo lote.

Para recalcular os totais registrados e conferir os hashes dos insumos:

```bash
npm run summarize
```

Esse comando apenas lê os arquivos locais. Ele não chama modelos e não modifica resultados.

## Método e evidências

Os dois provedores receberam o mesmo diálogo e os mesmos critérios, adaptados aos respectivos formatos de entrada. A concorrência foi de duas chamadas por provedor, sem repetição automática nem reutilização de respostas. Claude usou uma ferramenta forçada; Jev, perguntas do tipo `choice`. O gabarito ficou fora das entradas enviadas aos modelos.

O [relatório da execução original](docs/relatorio-execucao.md) detalha configuração, seleção, tarifas históricas, orçamento e captura. [media/jev-vs-claude-50.mp4](media/jev-vs-claude-50.mp4) contém o vídeo final, com reprodução em 1,5× indicada na imagem, sem áudio. `recording/` preserva os metadados da captura. Os scripts de gravação e renderização foram mantidos; a renderização usa Python, Pillow e FFmpeg.

O arquivo binário `capture.zip`, citado no relatório histórico, não integra este pacote para GitHub. Ele permanece no pacote original `jev-vs-claude-50-fontes.zip`, cujo SHA-256 é `40c29ac009acc543693f1cdf58f54f5147424e42ec325bc229c3cd658099300f`. Caminhos absolutos nos registros identificam o ambiente original da execução e não são requisitos para consultar os resultados.

Novas execuções pagas exigem configuração própria de chaves, modelos, tarifas, orçamento e um diretório de execução separado. Os resultados históricos foram preservados para auditoria.

## Autor

[Rafael Oliveira Rocha](https://rafaeloliveirarocha.github.io/)
