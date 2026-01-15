
## 🚀 Como Executar o Benchmark do K-Means

Este repositório contém um script de automação em Python que compila, executa e analisa o desempenho de 4 versões diferentes do algoritmo K-Means (de sequencial a otimizado com OpenMP).

### 📋 Pré-requisitos

Antes de iniciar, certifique-se de ter instalado em sua máquina:

* **GCC**: Compilador C com suporte a OpenMP.
* **Python 3.x**: Para rodar o script de automação.
* **Bibliotecas padrão**: O script utiliza `subprocess`, `os`, `csv` e `time` (já inclusas no Python).

### 📂 Estrutura Necessária

Para que o script funcione corretamente, os seguintes arquivos devem estar na **mesma pasta**:

1. `benchmark_script.py` (o código que você postou)
2. `gerador_dados.c` (responsável por criar a massa de testes)
3. `kmeans_1d_naive.c` (v1_seq)
4. `kmeans_1d_naive_2.c` (v2_assign)
5. `kmeans_1d_naive_3.c` (v3_critical)
6. `kmeans_final.c` (v4_opt)

### 🛠️ Execução

1. Abra o terminal na pasta do projeto.
2. Execute o script principal:
```bash
python3 benchmark_script.py

```



### 📊 O que o script faz?

O script automatiza todo o processo de análise de desempenho:

* **Compilação**: Compila todos os arquivos `.c` usando as flags `-O2` e `-fopenmp`.
* **Geração de Dados**: Cria arquivos `dados.csv` e `centroides_iniciais.csv` automaticamente para diferentes escalas (de 10^4 a 10^7 pontos).
* **Execução Multithread**: Testa cada versão com cargas de **1, 2, 4, 8, 16 e 32 threads**.
* **Validação**: Compara o **SSE** (Sum of Squared Errors) de cada versão paralela com a sequencial para garantir que o resultado está correto.
* **Métricas**: Calcula automaticamente o **Speedup** e a **Eficiência**.

### 📈 Resultados

Ao final da execução, será gerado um arquivo chamado `resultados_finais.csv`. Este arquivo contém as colunas:

* `N` e `K`: Escala do problema.
* `Tempo_ms`: Tempo de execução.
* `Speedup`: Ganho de performance em relação ao sequencial (S = T_{seq} / T_{par}).
* `Corretude`: Status da validação dos resultados.
