/* k_means_cuda.cu
   Compile: nvcc -O3 k_means_cuda.cu -o kmeans_cuda -lm
   Uso:     ./kmeans_cuda dados.csv centroides_iniciais.csv [max_iter=50] [eps=1e-4] [assign.csv] [centroids.csv]
*/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <cuda_runtime.h>

#define THREADS_PER_BLOCK 64

static int count_rows(const char *path){
    FILE *f = fopen(path, "r");
    if(!f){ fprintf(stderr,"Erro ao abrir %s\n", path); exit(1); }
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

static double *read_csv_1col(const char *path, int *n_out){
    int R = count_rows(path);
    if(R<=0){ fprintf(stderr,"Arquivo vazio: %s\n", path); exit(1); }
    double *A = (double*)malloc((size_t)R * sizeof(double));
    if(!A){ fprintf(stderr,"Sem memoria para %d linhas\n", R); exit(1); }

    FILE *f = fopen(path, "r");
    if(!f){ fprintf(stderr,"Erro ao abrir %s\n", path); free(A); exit(1); }

    char line[8192];
    int r=0;
    while(fgets(line,sizeof(line),f)){
        int only_ws=1;
        for(char *p=line; *p; p++){
            if(*p!=' ' && *p!='\t' && *p!='\n' && *p!='\r'){ only_ws=0; break; }
        }
        if(only_ws) continue;

        const char *delim = ",; \t";
        char *tok = strtok(line, delim);
        if(!tok){ fprintf(stderr,"Linha %d sem valor em %s\n", r+1, path); free(A); fclose(f); exit(1); }
        A[r] = atof(tok);
        r++;
        if(r>R) break;
    }
    fclose(f);
    *n_out = R;
    return A;
}

static void write_assign_csv(const char *path, const int *assign, int N){
    if(!path) return;
    FILE *f = fopen(path, "w");
    if(!f){ fprintf(stderr,"Erro ao abrir %s para escrita\n", path); return; }
    for(int i=0;i<N;i++) fprintf(f, "%d\n", assign[i]);
    fclose(f);
}

static void write_centroids_csv(const char *path, const double *C, int K){
    if(!path) return;
    FILE *f = fopen(path, "w");
    if(!f){ fprintf(stderr,"Erro ao abrir %s para escrita\n", path); return; }
    for(int c=0;c<K;c++) fprintf(f, "%.6f\n", C[c]);
    fclose(f);
}

/* --- util: checar erros CUDA --- */
static void checkCuda(cudaError_t err, const char *msg) {
    if(err != cudaSuccess){
        fprintf(stderr, "Erro CUDA: %s : %s\n", msg, cudaGetErrorString(err));
        exit(1);
    }
}

/* assignment kernel */
__global__ void assignment_step_1d_cuda(const double *X, const double *C, int *assign,
                                        int N, int K, double *g_sse_total){

    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        int best = -1;
        double bestd = 1.0e300;
        for(int c = 0; c < K; c++){
            double diff = X[i] - C[c];
            double d = diff * diff;
            if(d < bestd){
                bestd = d;
                best = c;
            }
        }
        assign[i] = best;
        // atomicAdd on double: requer SM >= 6.0 (verificação feita no host)
        atomicAdd(g_sse_total, bestd);
    }
}

static double assignment_step_1d(const double *X, const double *C, int *assign, int N, int K){

    double sse_total = 0.0;
    double *d_sse_total = NULL;
    double *d_X = NULL, *d_C = NULL;
    int *d_assign = NULL;

    checkCuda(cudaMalloc(&d_X, N * sizeof(double)), "cudaMalloc d_X");
    checkCuda(cudaMalloc(&d_C, K * sizeof(double)), "cudaMalloc d_C");
    checkCuda(cudaMalloc(&d_assign, N * sizeof(int)), "cudaMalloc d_assign");
    checkCuda(cudaMalloc(&d_sse_total, sizeof(double)), "cudaMalloc d_sse_total");

    checkCuda(cudaMemcpy(d_sse_total, &sse_total, sizeof(double), cudaMemcpyHostToDevice), "memcpy sse=0");
    checkCuda(cudaMemcpy(d_X, X, N * sizeof(double), cudaMemcpyHostToDevice), "memcpy X->d_X");
    checkCuda(cudaMemcpy(d_C, C, K * sizeof(double), cudaMemcpyHostToDevice), "memcpy C->d_C");

    int num_blocks = (N + THREADS_PER_BLOCK - 1) / THREADS_PER_BLOCK;

    assignment_step_1d_cuda<<<num_blocks, THREADS_PER_BLOCK>>>(
        d_X, d_C, d_assign, N, K, d_sse_total
    );

    cudaError_t err = cudaGetLastError();
    if(err != cudaSuccess){
        fprintf(stderr,"Kernel assignment error: %s\n", cudaGetErrorString(err));
        exit(1);
    }
    checkCuda(cudaDeviceSynchronize(), "synchronize after assignment kernel");

    checkCuda(cudaMemcpy(assign, d_assign, N * sizeof(int), cudaMemcpyDeviceToHost), "memcpy d_assign->assign");
    checkCuda(cudaMemcpy(&sse_total, d_sse_total, sizeof(double), cudaMemcpyDeviceToHost), "memcpy sse->host");

    cudaFree(d_X);
    cudaFree(d_C);
    cudaFree(d_assign);
    cudaFree(d_sse_total);

    return sse_total;
}

/* update kernel (somas + contagens) */
__global__ void update_kernel_1d(const double *X, double *d_sum, int *d_cnt,
                                 const int *assign, int N, int K) {

    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) {
        int a = assign[i];
        if (a >= 0 && a < K) {
            atomicAdd(&d_cnt[a], 1);
            atomicAdd(d_sum + a, X[i]);
        }
    }
}

void update_step_1d(const double *X, double *C, const int *assign, int N, int K) {

    double *d_X = NULL;
    double *d_sum = NULL;
    int *d_assign = NULL;
    int *d_cnt = NULL;

    double *h_sum = (double*)calloc((size_t)K, sizeof(double));
    int *h_cnt = (int*)calloc((size_t)K, sizeof(int));
    if(!h_sum || !h_cnt){ fprintf(stderr,"Sem memoria na CPU\n"); exit(1); }

    checkCuda(cudaMalloc(&d_X, N * sizeof(double)), "cudaMalloc d_X (update)");
    checkCuda(cudaMalloc(&d_assign, N * sizeof(int)), "cudaMalloc d_assign (update)");
    checkCuda(cudaMalloc(&d_sum, K * sizeof(double)), "cudaMalloc d_sum");
    checkCuda(cudaMalloc(&d_cnt, K * sizeof(int)), "cudaMalloc d_cnt");

    checkCuda(cudaMemcpy(d_X, X, N * sizeof(double), cudaMemcpyHostToDevice), "memcpy X->d_X (update)");
    checkCuda(cudaMemcpy(d_assign, assign, N * sizeof(int), cudaMemcpyHostToDevice), "memcpy assign->d_assign");
    checkCuda(cudaMemcpy(d_sum, h_sum, K * sizeof(double), cudaMemcpyHostToDevice), "init d_sum");
    checkCuda(cudaMemcpy(d_cnt, h_cnt, K * sizeof(int), cudaMemcpyHostToDevice), "init d_cnt");

    int num_blocks = (N + THREADS_PER_BLOCK - 1) / THREADS_PER_BLOCK;
    update_kernel_1d<<<num_blocks, THREADS_PER_BLOCK>>>(
        d_X, d_sum, d_cnt, d_assign, N, K
    );

    cudaError_t err = cudaGetLastError();
    if(err != cudaSuccess){
        fprintf(stderr,"Kernel update error: %s\n", cudaGetErrorString(err));
        exit(1);
    }
    checkCuda(cudaDeviceSynchronize(), "synchronize after update kernel");

    checkCuda(cudaMemcpy(h_sum, d_sum, K * sizeof(double), cudaMemcpyDeviceToHost), "memcpy d_sum->h_sum");
    checkCuda(cudaMemcpy(h_cnt, d_cnt, K * sizeof(int), cudaMemcpyDeviceToHost), "memcpy d_cnt->h_cnt");

    for(int c = 0; c < K; c++){
        if(h_cnt[c] > 0) C[c] = h_sum[c] / (double)h_cnt[c];
        else             C[c] = X[0]; /* estratégia naive se cluster vazio */
    }

    cudaFree(d_X);
    cudaFree(d_assign);
    cudaFree(d_sum);
    cudaFree(d_cnt);

    free(h_sum);
    free(h_cnt);
}

static void kmeans_1d(const double *X, double *C, int *assign,
                      int N, int K, int max_iter, double eps,
                      int *iters_out, double *sse_out)
{
    double prev_sse = 1e300;
    double sse = 0.0;
    int it;
    for(it=0; it<max_iter; it++){
        sse = assignment_step_1d(X, C, assign, N, K);
        double rel = fabs(sse - prev_sse) / (prev_sse > 0.0 ? prev_sse : 1.0);
        if(rel < eps){ it++; break; }
        update_step_1d(X, C, assign, N, K);
        prev_sse = sse;
    }
    *iters_out = it;
    *sse_out = sse;
}

/* ---------- main ---------- */
int main(int argc, char **argv){
    if(argc < 3){
        printf("Uso: %s dados.csv centroides_iniciais.csv [max_iter=50] [eps=1e-4] [assign.csv] [centroids.csv]\n", argv[0]);
        printf("Obs: arquivos CSV com 1 coluna (1 valor por linha), sem cabeçalho.\n");
        return 1;
    }
    const char *pathX = argv[1];
    const char *pathC = argv[2];
    int max_iter = (argc>3)? atoi(argv[3]) : 50;
    double eps   = (argc>4)? atof(argv[4]) : 1e-4;
    const char *outAssign   = (argc>5)? argv[5] : NULL;
    const char *outCentroid = (argc>6)? argv[6] : NULL;

    if(max_iter <= 0 || eps <= 0.0){
        fprintf(stderr,"Parâmetros inválidos: max_iter>0 e eps>0\n");
        return 1;
    }

    int N=0, K=0;
    double *X = read_csv_1col(pathX, &N);
    double *C = read_csv_1col(pathC, &K);
    int *assign = (int*)malloc((size_t)N * sizeof(int));
    if(!assign){ fprintf(stderr,"Sem memoria para assign\n"); free(X); free(C); return 1; }

    /* Verifica suporte de dispositivo para atomicAdd(double) */
    cudaDeviceProp prop;
    checkCuda(cudaGetDeviceProperties(&prop, 0), "cudaGetDeviceProperties");
    if(prop.major < 6){
        fprintf(stderr, "AVISO: sua GPU pode nao suportar atomicAdd(double) (required SM >= 6.0). Detalhes: SM %d.%d\n",
                prop.major, prop.minor);
        fprintf(stderr, "O programa pode falhar/produzir resultados incorretos em GPUs antigas.\n");
        /* Você pode optar por abortar aqui; eu continuo, mas aviso o usuário. */
    }

    clock_t t0 = clock();
    int iters = 0; double sse = 0.0;
    kmeans_1d(X, C, assign, N, K, max_iter, eps, &iters, &sse);
    clock_t t1 = clock();
    double ms = 1000.0 * (double)(t1 - t0) / (double)CLOCKS_PER_SEC;

    printf("K-means 1D (CUDA, naive)\n");
    printf("N=%d K=%d max_iter=%d eps=%g\n", N, K, max_iter, eps);
    printf("Iterações: %d | SSE final: %.6f | Tempo: %.1f ms\n", iters, sse, ms);

    write_assign_csv(outAssign, assign, N);
    write_centroids_csv(outCentroid, C, K);

    free(assign); free(X); free(C);
    return 0;
}
