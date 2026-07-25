from django.core.management.base import BaseCommand
from polls.services import rebuild_search_index


class Command(BaseCommand):
    help = "Rebuild the search index."

    def handle(self, *args, **options):
        rebuild_search_index()
