
````markdown
# Implementação Paralela do K-Means com MPI

Este projeto contém uma implementação paralela do algoritmo de agrupamento K-Means utilizando a biblioteca MPI (Message Passing Interface) em linguagem C.

## 📋 Pré-requisitos

* Compilador GCC
* Biblioteca MPI (OpenMPI ou MPICH)

## 🚀 Como Usar

### 1. Gerar Dados de Teste

Antes de executar o algoritmo, é necessário gerar os arquivos de entrada (`dados.csv` e `centroides_iniciais.csv`).

Compile e execute o gerador:

```bash
gcc gerar_dados.c -o gerar_dados
./gerar_dados
````

> **Nota:** Isso criará os arquivos CSV no diretório atual.

### 2\. Compilar o K-Means Paralelo

Compile o código principal utilizando o wrapper do MPI (`mpicc`):

```bash
mpicc -O2 kmeans_mpi.c -o kmeans_mpi -lm
```

### 3\. Executar

Para rodar o programa (exemplo com 4 processos):

```bash
mpirun -np 4 ./kmeans_mpi dados.csv centroides_iniciais.csv
```

  * O parâmetro `-np 4` define o número de processos.
  * Os argumentos seguintes são os arquivos de entrada gerados no passo 1.

-----

## ⚙️ Configuração dos Testes

Para alterar a quantidade de pontos ($N$) ou o número de clusters ($K$), edite as variáveis no início da função `main` dentro do arquivo `gerar_dados.c`:

```c
int main() {
    int n_dados = 10000000;      // Quantidade de pontos (N)
    int n_centroides = 32;       // Quantidade de centróides (K)
    double min = 0.0, max = 1000000000; 
    
    // ... restante do código
}
```

Após alterar esses valores, **recompile e execute** o `gerar_dados` (Passo 1) para atualizar os arquivos CSV.

```
```
