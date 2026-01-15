#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <omp.h>

// ... (Mantenha as funções de leitura de CSV e escrita iguais) ...
// ... Copie count_rows, read_csv_1col, write_assign_csv, write_centroids_csv daqui ... 
// ... ou mantenha as suas originais, elas estão corretas. ...

// Função auxiliar apenas para contar linhas (para o exemplo ficar completo)
static int count_rows(const char *path){
    FILE *f = fopen(path, "r");
    if(!f){ fprintf(stderr,"Erro ao abrir %s\n", path); exit(1); }
    int rows=0; char line[8192];
    while(fgets(line,sizeof(line),f)){
        int only_ws=1;
        for(char *p=line; *p; p++){ if(*p!=' ' && *p!='\t' && *p!='\n' && *p!='\r'){ only_ws=0; break; } }
        if(!only_ws) rows++;
    }
    fclose(f); return rows;
}
static double *read_csv_1col(const char *path, int *n_out){
    int R = count_rows(path);
    double *A = (double*)malloc((size_t)R * sizeof(double));
    FILE *f = fopen(path, "r");
    char line[8192]; int r=0;
    while(fgets(line,sizeof(line),f)){
        char *tok = strtok(line, ",; \t");
        if(tok){ A[r++] = atof(tok); if(r>=R) break; }
    }
    fclose(f); *n_out = R; return A;
}
static void write_assign_csv(const char *path, const int *assign, int N){
    if(!path) return; FILE *f = fopen(path, "w");
    for(int i=0;i<N;i++) fprintf(f, "%d\n", assign[i]); fclose(f);
}
static void write_centroids_csv(const char *path, const double *C, int K){
    if(!path) return; FILE *f = fopen(path, "w");
    for(int c=0;c<K;c++) fprintf(f, "%.6f\n", C[c]); fclose(f);
}

/* LÓGICA DO K-MEANS INTEGRADA
   Para evitar overhead, movemos a lógica para dentro de uma única função
   onde a região paralela é aberta apenas uma vez.
*/
static void kmeans_1d_parallel(const double *X, double *C, int *assign,
                               int N, int K, int max_iter, double eps,
                               int *iters_out, double *sse_out)
{
    int it = 0;
    double sse = 0.0;
    double prev_sse = 1e300;
    int converged = 0;

    // 1. Abertura das threads (apenas UMA vez)
    #pragma omp parallel
    {
        // Variáveis privadas de cada thread para o passo de Update
        // Isso evita o uso de 'critical' dentro do loop grande
        double *local_sum = (double*)malloc(K * sizeof(double));
        int *local_cnt = (int*)malloc(K * sizeof(int));
        
        int my_it = 0; // iteração local

        while(my_it < max_iter && !converged){
            
            // --- PASSO 1: ASSIGNMENT ---
            double local_sse = 0.0;
            
            // 'omp for' distribui o loop entre as threads já existentes.
            // 'nowait' não é usado aqui pois precisamos sincronizar o SSE depois
            #pragma omp for reduction(+:sse)
            for(int i=0; i<N; i++){
                double v = X[i];
                int best = -1;
                double bestd = 1e300;
                // K geralmente é pequeno, loop sequencial aqui é ok
                for(int c=0; c<K; c++){
                    double diff = v - C[c];
                    double d = diff*diff;
                    if(d < bestd){ bestd = d; best = c; }
                }
                assign[i] = best;
                local_sse += bestd; // O reduction cuida da soma global em 'sse'
            }

            // Apenas a thread mestre verifica convergência e reseta variáveis globais
            #pragma omp single
            {
                double rel = fabs(sse - prev_sse) / (prev_sse > 0.0 ? prev_sse : 1.0);
                if(rel < eps) converged = 1;
                
                prev_sse = sse;
                sse = 0.0; // Reseta para a próxima iteração
                
                // Limpa os centróides globais para acumular as médias
                // (Note que não atualizamos C aqui ainda, vamos recalcular)
            }
            // Barreira implícita do 'omp single' garante que todos saibam se convergiu

            if(converged) break;

            // --- PASSO 2: UPDATE (Otimizado com Arrays Locais) ---
            
            // Limpa arrays locais
            for(int k=0; k<K; k++){ local_sum[k] = 0.0; local_cnt[k] = 0; }

            // Cada thread calcula sua parte da soma sem travas (lock-free)
            #pragma omp for nowait
            for(int i=0; i<N; i++){
                int c = assign[i];
                local_sum[c] += X[i];
                local_cnt[c] += 1;
            }

            // Agora mesclamos os resultados locais no global de forma segura
            // Isso roda apenas Num_Threads vezes, e não N vezes! Muito mais rápido.
            #pragma omp critical
            {
                // Usamos C[] temporariamente para acumular a soma global
                // (precisamos zerar C antes? Sim, vamos fazer um truque no single abaixo)
                // Para simplificar, vamos assumir que o mestre zera arrays auxiliares globais
                // Mas como não alocamos aux global, vamos fazer apenas a thread mestre calcular
                // a média final depois.
                
                // Abordagem melhor: ter arrays globais auxiliares seria ideal,
                // mas para manter a assinatura da função, vamos usar critical aqui.
                // Como K é pequeno e loop roda poucas vezes (só número de threads), é rápido.
            }
        }
        
        // --- CORREÇÃO DA LÓGICA DE UPDATE PARA EVITAR COMPLEXIDADE ---
        // A lógica acima ficou complexa de explicar num único bloco. 
        // Vamos usar a abordagem CLÁSSICA DE REDUÇÃO MANUAL mais limpa abaixo:
        
        while(!converged && my_it < max_iter) {
             // ---------------- ASSIGNMENT ----------------
             #pragma omp barrier
             #pragma omp single
             { sse = 0.0; } // Zera sse global

             double my_sse = 0.0;
             #pragma omp for nowait
             for(int i=0; i<N; i++){
                double min_dist = 1e300;
                int best_k = -1;
                for(int k=0; k<K; k++){
                    double d = (X[i] - C[k]) * (X[i] - C[k]);
                    if(d < min_dist){ min_dist = d; best_k = k; }
                }
                assign[i] = best_k;
                my_sse += min_dist;
             }
             
             // Redução do SSE manual com atomic (mais leve que critical para escalar simples)
             #pragma omp atomic
             sse += my_sse;

             #pragma omp barrier // Espera todos calcularem assign e sse

             // Check convergência (Single Thread)
             #pragma omp single
             {
                 double rel = fabs(sse - prev_sse) / (prev_sse > 0.0 ? prev_sse : 1.0);
                 if(rel < eps) converged = 1;
                 else {
                     prev_sse = sse;
                     my_it++;
                 }
                 // Zera acumuladores globais se tivéssemos. 
                 // Como C é entrada/saída, precisamos de buffers temporários globais 
                 // ou fazer redução local -> global.
             }
             
             if(converged) break;

             // ---------------- UPDATE ----------------
             // 1. Limpa acumuladores locais
             for(int k=0; k<K; k++) { local_sum[k] = 0.0; local_cnt[k] = 0; }

             // 2. Acumula localmente (SEM CRITICAL, SEM ATOMIC)
             #pragma omp for nowait
             for(int i=0; i<N; i++){
                 int c = assign[i];
                 local_sum[c] += X[i];
                 local_cnt[c]++;
             }

             // 3. Thread Master zera os centróides para usá-los como acumuladores
             #pragma omp barrier
             #pragma omp single
             {
                 // Zera C para usar como acumulador de soma, e precisaremos de um buffer para contagem
                 // Como não podemos alocar dentro do single facilmente para todos verem sem mudar assinatura,
                 // vamos fazer o update global dentro de uma critical section por thread.
             }

             // Como não temos array global de contagem (cnt), vamos alocar um estático ou
             // confiar que K é pequeno e fazer a redução dentro de critical.
             // O C[] guarda a posição atual. Não podemos sobrescrevê-lo concorrentemente.
             // Vamos precisar de barreiras.
             
             // Solução Robusta: Arrays globais de soma e contagem alocados fora do while
        }
        
        free(local_sum);
        free(local_cnt);
    } // Fim do Parallel

    // Para simplificar a didática e o código, vou reescrever a função inteira abaixo
    // usando a estrutura correta de alocação de memória auxiliar.
    *iters_out = it; 
    *sse_out = sse;
}

// ---------------- VERSÃO FINAL LIMPA E OTIMIZADA ----------------
static void kmeans_1d_optimized(const double *X, double *C, int *assign,
                                int N, int K, int max_iter, double eps,
                                int *iters_out, double *sse_out)
{
    double prev_sse = 1e300;
    double global_sse = 0.0;
    int it = 0;
    int converged = 0;

    // Aloca buffers globais para a etapa de redução (Update)
    // Assim não dependemos de locks por ponto, apenas por thread
    double *global_sum = (double*)calloc(K, sizeof(double));
    int *global_cnt = (int*)calloc(K, sizeof(int));

    // INÍCIO DA REGIÃO PARALELA (Cria threads uma vez)
    #pragma omp parallel
    {
        // Alocação privada (na pilha de cada thread ou heap local)
        double *my_sum = (double*)malloc(K * sizeof(double));
        int *my_cnt = (int*)malloc(K * sizeof(int));
        
        while(it < max_iter && !converged) {
            
            // --- ASSIGNMENT STEP ---
            double my_sse = 0.0;
            
            #pragma omp for nowait
            for(int i=0; i<N; i++){
                double best_dist = 1e300;
                int best_k = 0;
                double val = X[i];
                // Loop pequeno (K), manter sequencial
                for(int k=0; k<K; k++){
                    double diff = val - C[k];
                    double d = diff*diff;
                    if(d < best_dist){ best_dist = d; best_k = k; }
                }
                assign[i] = best_k;
                my_sse += best_dist;
            }

            // Reduz SSE
            #pragma omp atomic
            global_sse += my_sse;

            // Barreira para garantir que assignment terminou antes de checar convergência
            #pragma omp barrier 

            // --- CHECK CONVERGENCE & PREP UPDATE ---
            #pragma omp single
            {
                double rel = fabs(global_sse - prev_sse) / (prev_sse > 0.0 ? prev_sse : 1.0);
                if(rel < eps) converged = 1;
                
                prev_sse = global_sse;
                if(!converged) {
                    global_sse = 0.0; // Reseta para próxima
                    // Zera acumuladores globais
                    memset(global_sum, 0, K * sizeof(double));
                    memset(global_cnt, 0, K * sizeof(int));
                }
            }
            // Barreira implícita no single, ou explícita se usasse nowait
            
            if(converged) {
                // Necessário soltar a memória local antes de quebrar o while
                // (O free está lá embaixo, fora do while)
            } else {
                
                // --- UPDATE STEP (PARTE 1: ACUMULAÇÃO LOCAL) ---
                // Zera local
                for(int k=0; k<K; k++){ my_sum[k]=0.0; my_cnt[k]=0; }
                
                // O 'omp for' aqui já divide o trabalho do array assign (que é size N)
                #pragma omp for nowait
                for(int i=0; i<N; i++){
                    int c = assign[i];
                    my_sum[c] += X[i];
                    my_cnt[c]++;
                }

                // --- UPDATE STEP (PARTE 2: REDUÇÃO GLOBAL) ---
                // Cada thread joga seus resultados no global dentro de uma critical
                // Isso ocorre poucas vezes (ex: 4, 8 vezes), não N vezes.
                #pragma omp critical
                {
                    for(int k=0; k<K; k++){
                        global_sum[k] += my_sum[k];
                        global_cnt[k] += my_cnt[k];
                    }
                }
                
                // Espera todos terminarem de atualizar global_sum/cnt
                #pragma omp barrier

                // --- UPDATE STEP (PARTE 3: CÁLCULO DA MÉDIA) ---
                #pragma omp single
                {
                    for(int k=0; k<K; k++){
                        if(global_cnt[k] > 0) C[k] = global_sum[k] / global_cnt[k];
                        // else mantém C[k] anterior ou reinicia (política naive)
                    }
                    it++;
                }
            } // else converged
            
            #pragma omp barrier 
        } // while

        free(my_sum);
        free(my_cnt);
    } // fim parallel

    free(global_sum);
    free(global_cnt);
    *iters_out = it;
    *sse_out = prev_sse;
}

int main(int argc, char **argv){
    // ... (mesmo código de argumentos do seu main) ...
    if(argc < 3){ return 1; } // Simplificado
    const char *pathX = argv[1];
    const char *pathC = argv[2];
    int max_iter = (argc>3)? atoi(argv[3]) : 50;
    double eps    = (argc>4)? atof(argv[4]) : 1e-4;

    int N=0, K=0;
    double *X = read_csv_1col(pathX, &N);
    double *C = read_csv_1col(pathC, &K);
    int *assign = (int*)malloc(N * sizeof(int));

    // MUDANÇA IMPORTANTE: Use omp_get_wtime para medir tempo de parede (Wall Clock)
    // clock() mede tempo de CPU somado (paralelo parece levar mais tempo)
    double t0 = omp_get_wtime();
    
    int iters = 0; double sse = 0.0;
    kmeans_1d_optimized(X, C, assign, N, K, max_iter, eps, &iters, &sse);
    
    double t1 = omp_get_wtime();
    double ms = (t1 - t0) * 1000.0;

    printf("K-means 1D (Optimized OpenMP)\n");
    printf("N=%d K=%d Iter=%d SSE=%.6f Tempo=%.2f ms\n", N, K, iters, sse, ms);

    // ... (código de escrita CSV) ...
    free(assign); free(X); free(C);
    return 0;
}
