import psutil

def analyze_ram():
    """
    Analyse la RAM physique et calcule la "RAM Fantôme" (différence entre la RAM globale 
    utilisée rapportée par le système et la somme de la mémoire des processus actifs).
    """
    # Mémoire globale
    vm = psutil.virtual_memory()
    total_ram = vm.total
    used_ram = vm.used
    percent_used = vm.percent

    # Somme de la mémoire des processus actifs
    sum_process_memory = 0
    for proc in psutil.process_iter(['memory_info']):
        try:
            mem_info = proc.info.get('memory_info')
            if mem_info:
                sum_process_memory += mem_info.rss # Resident Set Size
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass

    # Calcul de la RAM fantôme (Souvent Kernel Memory, Non-Paged Pool, etc.)
    # Note: vm.used n'est pas toujours exactement égal à la somme des processus + Kernel.
    # Ceci est une approximation éducative/diagnostique pour mettre en évidence les fuites systèmes.
    phantom_ram = used_ram - sum_process_memory
    if phantom_ram < 0:
        phantom_ram = 0

    return {
        "total_ram_mb": round(total_ram / (1024 * 1024), 2),
        "used_ram_mb": round(used_ram / (1024 * 1024), 2),
        "percent_used": percent_used,
        "sum_process_memory_mb": round(sum_process_memory / (1024 * 1024), 2),
        "phantom_ram_mb": round(phantom_ram / (1024 * 1024), 2)
    }
