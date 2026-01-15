import subprocess
import os
import csv
import time

# --- CONFIGURAÇÕES DE TESTE ---

# Mapeamento (N_Dados, K_Centroides)
CONFIGURACOES = [
    (10000, 4),       # 10^4
    (1000000, 16),    # 10^6
    (10000000, 32),   # 10^7
    # (100000000, 64) # 10^8 (Descomente se tiver muita RAM/Tempo)
]

THREADS_LIST = [1, 2, 4, 8, 16, 32]

# Nomes dos seus arquivos .c
SOURCES = {
    "v1_seq": "kmeans_1d_naive.c",
    "v2_assign": "kmeans_1d_naive_2.c",
    "v3_critical": "kmeans_1d_naive_3.c",
    "v4_opt": "kmeans_final.c" 
}

OUTPUT_CSV = "resultados_finais.csv"
MAX_ITER = 50
EPS = 1e-4
TIMEOUT_SEC = 300 # 5 minutos limite por execução (pra não travar na v3)

# ---------------------------------------------------------

def compile_all():
    print("--- 1. Compilando códigos ---")
    # Gerador
    if not os.path.exists("gerador_dados.c"):
        print("ERRO: gerador_dados.c não encontrado!")
        exit(1)
    subprocess.run(["gcc", "gerador_dados.c", "-o", "gerador", "-O2"], check=True)
    
    # Versões K-Means
    for nome, src in SOURCES.items():
        if not os.path.exists(src):
            print(f"ERRO: {src} não encontrado!")
            exit(1)
        # Compila com OpenMP e Math lib
        cmd = ["gcc", "-O2", "-std=c99", "-fopenmp", src, "-o", nome, "-lm"]
        subprocess.run(cmd, check=True)
        print(f"  > {nome} compilado.")
    print("--- Compilação concluída ---\n")

def run_test(executable, n_threads, dados, centros, out_assign, out_cent):
    env = os.environ.copy()
    env["OMP_NUM_THREADS"] = str(n_threads)
    
    cmd = [f"./{executable}", dados, centros, str(MAX_ITER), str(EPS), out_assign, out_cent]
    
    try:
        # Executa com Timeout
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=TIMEOUT_SEC)
        
        if result.returncode != 0:
            return None, None, "ERRO_RETORNO"

        # Parser da saída (Procura por "Tempo: X ms" e "SSE final: Y")
        output = result.stdout
        sse = -1.0
        tempo_ms = -1.0
        
        for line in output.split('\n'):
            if "SSE final" in line:
                # Exemplo esperado: ... SSE final: 1234.56 ... Tempo: 50.0 ms
                try:
                    parts = line.split('|')
                    for p in parts:
                        if "SSE final" in p:
                            sse = float(p.split(':')[1].strip())
                        if "Tempo" in p:
                            tempo_ms = float(p.split(':')[1].replace('ms','').strip())
                except:
                    pass
        
        return tempo_ms, sse, "OK"
        
    except subprocess.TimeoutExpired:
        return None, None, "TIMEOUT"
    except Exception as e:
        return None, None, f"ERRO: {str(e)}"

def read_centroids_for_check(filename):
    try:
        with open(filename, 'r') as f:
            return [float(line) for line in f if line.strip()]
    except:
        return []

def main():
    compile_all()
    
    with open(OUTPUT_CSV, 'w', newline='') as f:
        cols = ['N', 'K', 'Versao', 'Threads', 'Tempo_ms', 'SSE', 'Speedup', 'Eficiencia', 'Status', 'Corretude']
        writer = csv.DictWriter(f, fieldnames=cols)
        writer.writeheader()
        
        for n_dados, k_centroides in CONFIGURACOES:
            print(f"\n>>> GERANDO DADOS: N={n_dados}, K={k_centroides}")
            subprocess.run(["./gerador", str(n_dados), str(k_centroides)], check=True)
            
            # --- 1. Rodar Baseline Sequencial (1 Thread) ---
            print(f"  > Rodando Baseline (Sequencial)...")
            t_base, sse_base, stat_base = run_test("v1_seq", 1, "dados.csv", "centroides_iniciais.csv", "assign_base.csv", "cent_base.csv")
            
            if stat_base != "OK":
                print(f"    [FALHA] Baseline falhou ({stat_base}). Pulando N={n_dados}")
                continue
                
            cents_base = read_centroids_for_check("cent_base.csv")
            
            # Registra Baseline
            writer.writerow({
                'N': n_dados, 'K': k_centroides, 'Versao': 'v1_seq', 'Threads': 1,
                'Tempo_ms': t_base, 'SSE': sse_base, 'Speedup': 1.0, 'Eficiencia': 1.0,
                'Status': 'OK', 'Corretude': 'BASELINE'
            })
            
            # --- 2. Rodar Todas as Versões com Varias Threads ---
            for nome_ver in ["v1_seq", "v2_assign", "v3_critical", "v4_opt"]:
                
                # Se for a sequencial, rodamos de novo com varias threads? 
                # OpenMP ignora threads se não tiver pragma, mas vamos rodar pra confirmar overhead nulo.
                # Se quiser pular a v1 aqui, pode adicionar um if.
                
                for t in THREADS_LIST:
                    if nome_ver == "v1_seq" and t == 1: continue # Já rodamos
                    
                    print(f"    Executando {nome_ver} [T={t}]... ", end="", flush=True)
                    
                    t_run, sse_run, status = run_test(nome_ver, t, "dados.csv", "centroides_iniciais.csv", "assign_cur.csv", "cent_cur.csv")
                    
                    if status != "OK":
                        print(f"[{status}]")
                        writer.writerow({
                            'N': n_dados, 'K': k_centroides, 'Versao': nome_ver, 'Threads': t,
                            'Tempo_ms': '', 'SSE': '', 'Speedup': 0, 'Eficiencia': 0,
                            'Status': status, 'Corretude': '-'
                        })
                        continue
                    
                    # Cálculos
                    speedup = t_base / t_run if t_run > 0 else 0
                    efic = speedup / t
                    
                    # Verificação Simplificada
                    correto = "SIM"
                    # 1. Checa SSE (Erro relativo < 1%)
                    if abs((sse_base - sse_run)/sse_base) > 0.01: correto = "SSE_DIFERENTE"
                    
                    # 2. Checa Centróides (se SSE bateu, geralmente isso bate, mas vamos checar tamanho)
                    cents_run = read_centroids_for_check("cent_cur.csv")
                    if len(cents_run) != len(cents_base): correto = "ERRO_K"
                    
                    print(f"{t_run:.1f}ms | Sp: {speedup:.2f} | {correto}")
                    
                    writer.writerow({
                        'N': n_dados, 'K': k_centroides, 'Versao': nome_ver, 'Threads': t,
                        'Tempo_ms': t_run, 'SSE': sse_run, 
                        'Speedup': f"{speedup:.4f}", 'Eficiencia': f"{efic:.4f}",
                        'Status': status, 'Corretude': correto
                    })
                    f.flush() # Salva no disco imediatamente

    print(f"\nCONCLUÍDO! Arquivo gerado: {OUTPUT_CSV}")

if __name__ == "__main__":
    main()
