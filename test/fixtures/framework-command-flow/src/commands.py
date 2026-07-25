import click
from .services import run_cleanup

@click.command()
def cleanup():
    run_cleanup()
