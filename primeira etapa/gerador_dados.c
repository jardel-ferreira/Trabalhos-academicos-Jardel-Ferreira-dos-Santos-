#include <stdio.h>
#include <stdlib.h>
#include <time.h>

/* Uso: ./gerador <N> <K> */
int main(int argc, char **argv) {
    if (argc < 3) return 1;
    long n_dados = atol(argv[1]);
    int k = atoi(argv[2]);
    
    double *centros_reais = malloc(k * sizeof(double));
    for(int i=0; i<k; i++) centros_reais[i] = (i + 1) * 10.0; 

    srand(time(NULL));

    FILE *f_dados = fopen("dados.csv", "w");
    for (long i = 0; i < n_dados; i++) {
        int idx = rand() % k;
        double ruido = ((double)rand() / RAND_MAX * 5.0) - 2.5; 
        fprintf(f_dados, "%.6f\n", centros_reais[idx] + ruido);
    }
    fclose(f_dados);

    FILE *f_centroides = fopen("centroides_iniciais.csv", "w");
    for (int i = 0; i < k; i++) {
        double chute = ((double)rand() / RAND_MAX) * (k * 15.0);
        fprintf(f_centroides, "%.6f\n", chute);
    }
    fclose(f_centroides);
    free(centros_reais);
    return 0;
}
