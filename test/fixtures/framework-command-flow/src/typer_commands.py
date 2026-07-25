import typer
from .services import run_cleanup

app = typer.Typer()

@app.command("purge")
def purge_cache():
    run_cleanup()
