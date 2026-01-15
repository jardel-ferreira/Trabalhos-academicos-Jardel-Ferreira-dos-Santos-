/* kmeans_mpi.c
   Compilar: mpicc -O2 kmeans_mpi.c -o kmeans_mpi -lm
   Rodar:    mpirun -np 4 ./kmeans_mpi dados.csv centroides_iniciais.csv
*/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <mpi.h>

/* ========================================================================= */
/* FUNÇÕES AUXILIARES                           */
/* ========================================================================= */

// Conta linhas do arquivo
static int count_rows(const char *path){
    FILE *f = fopen(path, "r");
    if(!f){ return -1; }
    int rows=0; char line[8192];
    while(fgets(line,sizeof(line),f)){
        int only_ws=1;
        for(char *p=line; *p; p++){
            if(*p!=' ' && *p!='\t' && *p!='\n' && *p!='\r'){ only_ws=0; break; }
        }
        if(!only_ws) rows++;
    }
    fclose(f);
    return rows;
}

// Lê CSV de 1 coluna
static double *read_csv_1col(const char *path, int *n_out){
    int R = count_rows(path);
    if(R<=0){ return NULL; }
    double *A = (double*)malloc((size_t)R * sizeof(double));
    
    FILE *f = fopen(path, "r");
    char line[8192];
    int r=0;
    while(fgets(line,sizeof(line),f)){
        const char *delim = ",; \t";
        char *tok = strtok(line, delim);
        if(tok){
            A[r++] = atof(tok);
            if(r >= R) break;
        }
    }
    fclose(f);
    *n_out = R;
    return A;
}

// Escreve resultados
static void write_assign_csv(const char *path, const int *assign, int N){
    if(!path) return;
    FILE *f = fopen(path, "w");
    if(!f) return;
    for(int i=0;i<N;i++) fprintf(f, "%d\n", assign[i]);
    fclose(f);
}

static void write_centroids_csv(const char *path, const double *C, int K){
    if(!path) return;
    FILE *f = fopen(path, "w");
    if(!f) return;
    for(int c=0;c<K;c++) fprintf(f, "%.6f\n", C[c]);
    fclose(f);
}

/* ========================================================================= */
/* LÓGICA K-MEANS MPI                              */
/* ========================================================================= */

/* Executa o K-means distribuído */
static void kmeans_mpi_loop(const double *local_X, int n_local, 
                            double *C, int K, 
                            int *local_assign, 
                            int max_iter, double eps, 
                            int *iters_out, double *sse_out,
                            int rank, int size)
{
    double prev_global_sse = 1e300;
    double global_sse = 0.0;
    int it = 0;

    // Buffers para redução (Somas locais e contadores locais)
    double *local_sum = (double*)malloc(K * sizeof(double));
    int *local_cnt = (int*)malloc(K * sizeof(int));
    
    double *global_sum_buf = (double*)malloc(K * sizeof(double));
    int *global_cnt_buf = (int*)malloc(K * sizeof(int));

    for(it = 0; it < max_iter; it++){
        // 1. Resetar acumuladores locais
        for(int k=0; k<K; k++){ 
            local_sum[k] = 0.0; 
            local_cnt[k] = 0; 
        }
        double local_sse = 0.0;

        // 2. ASSIGNMENT STEP (Local)
        // Cada processo calcula distâncias apenas para os seus pontos (local_X)
        for(int i = 0; i < n_local; i++){
            int best_c = -1;
            double best_dist = 1e300;
            
            for(int c = 0; c < K; c++){
                double diff = local_X[i] - C[c];
                double dist = diff * diff;
                if(dist < best_dist){
                    best_dist = dist;
                    best_c = c;
                }
            }
            local_assign[i] = best_c;
            local_sse += best_dist;

            // Já acumula para o update
            local_sum[best_c] += local_X[i];
            local_cnt[best_c]++;
        }

        // 3. COMUNICAÇÃO (Redução Global)
        // Somar SSE local de todos para decidir convergência
        MPI_Allreduce(&local_sse, &global_sse, 1, MPI_DOUBLE, MPI_SUM, MPI_COMM_WORLD);

        // Somar contadores e somas de coordenadas de todos os processos
        MPI_Allreduce(local_sum, global_sum_buf, K, MPI_DOUBLE, MPI_SUM, MPI_COMM_WORLD);
        MPI_Allreduce(local_cnt, global_cnt_buf, K, MPI_INT, MPI_SUM, MPI_COMM_WORLD);

        // 4. UPDATE STEP (Todos atualizam sua cópia de C)
        for(int c = 0; c < K; c++){
            if(global_cnt_buf[c] > 0){
                C[c] = global_sum_buf[c] / global_cnt_buf[c];
            }
            // Se cluster vazio, mantém posição anterior (simplificação)
        }

        // 5. Verificação de Convergência
        double rel = fabs(global_sse - prev_global_sse) / (prev_global_sse > 0.0 ? prev_global_sse : 1.0);
        if(rel < eps) {
            it++; // Conta esta iteração
            break; 
        }
        prev_global_sse = global_sse;
    }

    *iters_out = it;
    *sse_out = global_sse;

    free(local_sum); free(local_cnt);
    free(global_sum_buf); free(global_cnt_buf);
}

/* ========================================================================= */
/* MAIN                                    */
/* ========================================================================= */

int main(int argc, char **argv){
    MPI_Init(&argc, &argv);

    int rank, size;
    MPI_Comm_rank(MPI_COMM_WORLD, &rank);
    MPI_Comm_size(MPI_COMM_WORLD, &size);

    // Parâmetros (padrão ou linha de comando)
    const char *pathX = (argc>1)? argv[1] : "dados.csv";
    const char *pathC = (argc>2)? argv[2] : "centroides.csv";
    int max_iter = (argc>3)? atoi(argv[3]) : 50;
    double eps   = (argc>4)? atof(argv[4]) : 1e-4;

    int N_global = 0;
    int K = 0;
    double *X_full = NULL; // Só existe no rank 0
    double *C = NULL;      // Existe em todos (cópia completa)

    // --- LEITURA DE DADOS (Apenas Rank 0) ---
    if(rank == 0){
        X_full = read_csv_1col(pathX, &N_global);
        C = read_csv_1col(pathC, &K);

        if(!X_full || !C){
            fprintf(stderr, "Erro ao ler arquivos.\n");
            MPI_Abort(MPI_COMM_WORLD, 1);
        }

        // Simples verificação de divisibilidade para este exemplo escolar
        if(N_global % size != 0){
            fprintf(stderr, "Aviso: N (%d) não é divisível por %d. O fim do array será cortado no Scatter.\n", N_global, size);
        }
    }

    // --- BROADCAST DE METADADOS ---
    // Todos precisam saber o tamanho total N e número de clusters K
    MPI_Bcast(&N_global, 1, MPI_INT, 0, MPI_COMM_WORLD);
    MPI_Bcast(&K, 1, MPI_INT, 0, MPI_COMM_WORLD);

    // Alocar Centróides nos workers
    if(rank != 0) {
        C = (double*)malloc(K * sizeof(double));
    }
    // Envia os centróides iniciais para todos
    MPI_Bcast(C, K, MPI_DOUBLE, 0, MPI_COMM_WORLD);


    // --- SCATTER DOS DADOS ---
    int n_local = N_global / size; 
    double *local_X = (double*)malloc(n_local * sizeof(double));
    int *local_assign = (int*)malloc(n_local * sizeof(int));

    MPI_Scatter(X_full, n_local, MPI_DOUBLE, 
                local_X, n_local, MPI_DOUBLE, 
                0, MPI_COMM_WORLD);


    // --- EXECUÇÃO DO ALGORITMO ---
    int iters_final = 0;
    double sse_final = 0.0;
    double start_time = MPI_Wtime();

    kmeans_mpi_loop(local_X, n_local, C, K, local_assign, 
                    max_iter, eps, &iters_final, &sse_final, rank, size);

    double end_time = MPI_Wtime();


    // --- RECOLHA DE RESULTADOS (GATHER) ---
    int *full_assign = NULL;
    if(rank == 0){
        full_assign = (int*)malloc(N_global * sizeof(int));
    }

    MPI_Gather(local_assign, n_local, MPI_INT, 
               full_assign, n_local, MPI_INT, 
               0, MPI_COMM_WORLD);


    // --- SAÍDA ---
    if(rank == 0){
        printf("K-means MPI concluído.\n");
        printf("Processos: %d | N: %d | K: %d\n", size, N_global, K);
        printf("Iterações: %d | SSE: %.6f | Tempo: %.4f s\n", iters_final, sse_final, end_time - start_time);
        
        // Salvar arquivos opcionais
        if(argc > 5) write_assign_csv(argv[5], full_assign, N_global);
        if(argc > 6) write_centroids_csv(argv[6], C, K);

        free(X_full);
        free(full_assign);
    }

    // Limpeza
    free(local_X);
    free(local_assign);
    free(C);

    MPI_Finalize();
    return 0;
}
