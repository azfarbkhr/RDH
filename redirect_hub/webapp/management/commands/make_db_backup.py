from django.core.management.base import BaseCommand
from django.apps import apps
import pyodbc

class Command(BaseCommand):
    help = 'Copies data from the default database to another database'

    def handle(self, *args, **kwargs):
        second_db_connection = pyodbc.connect('DRIVER={ODBC Driver 18 for SQL Server};SERVER=uttlsolutions.com;DATABASE=LinkRedirect;UID=AzfarBukhari;PWD=ABukhari;TrustServerCertificate=yes')

        # Get all models in your app
        models = apps.get_models()

        for model in models:
            # Get all records for each model
            records = model.objects.all()

            for record in records:
                columns = [field.name for field in model._meta.fields]
                values = [getattr(record, field) for field in columns]

                # Generate SQL insert statement for the second database
                # This is a simple example and might need to be adjusted depending on your database schema
                insert_statement = f"INSERT INTO {model._meta.db_table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})"

                # Execute the insert statement on the second database
                cursor = second_db_connection.cursor()
                cursor.execute(insert_statement, values)
                cursor.commit()

        second_db_connection.close()
