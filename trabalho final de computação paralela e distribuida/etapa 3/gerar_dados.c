#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main() {
    int n_dados = 10000000;      // quantidade de pontos
    int n_centroides = 32;    // quantidade de centróides
    double min = 0.0, max = 1000000000;

    FILE *f_dados = fopen("dados.csv", "w");
    FILE *f_centroides = fopen("centroides_iniciais.csv", "w");

    if (!f_dados || !f_centroides) {
        perror("Erro ao criar arquivos");
        return 1;
    }

    srand(time(NULL));

    // Gera dados aleatórios
    for (int i = 0; i < n_dados; i++) {
        double x = min + (max - min) * rand() / RAND_MAX;
        fprintf(f_dados, "%.6f\n", x);
    }

    // Gera centróides iniciais
    for (int i = 0; i < n_centroides; i++) {
        double c = min + (max - min) * rand() / RAND_MAX;
        fprintf(f_centroides, "%.6f\n", c);
    }

    fclose(f_dados);
    fclose(f_centroides);

    printf("Arquivos gerados: dados.csv e centroides_iniciais.csv\n");
    return 0;
}
