from flask import Flask
from .services import run_cleanup

app = Flask(__name__)

@app.cli.command()
def sync():
    run_cleanup()
