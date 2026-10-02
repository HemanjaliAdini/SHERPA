from turingdb import TuringDB
# Create TuringDB client
# set host parameter to the URL (as string) on which TuringDB is running,
# default "http://localhost:6666"
client = TuringDB(host="http://localhost:6666")
# Create a new graph called my_graph
client.create_graph("mygraph")

# Set working graph
client.set_graph("mygraph")

# Create a new change on the graph
change = client.new_change()

# Checkout into the change
client.checkout(change=change)

# Create a node Person (Jane) - Edge (knows) - node (John)
client.query("CREATE (n:Person {name: 'Jane'})-[e:KNOWS]->(m:Person {name: 'John'})")
# client.query(
# """
# CREATE (:Casualty {id, lat, lon, time_of_injury, status, triage_category, mobility}) 
# CREATE (:Medic {id, callsign, lat, lon}) 
# CREATE (:MedicalPoint {id, name, lat, lon, type, capabilities, state, free_beds}) 
# CREATE (:Vehicle {id, type, lat, lon, litter_capacity, ambulatory_capacity, range_km, battery_pct, max_threat, status}) 
# CREATE (:Junction {id, lat, lon}) 
# CREATE (:Threat {id, type, level, active})
# CREATE(:Mission {id, status, created_at, eta}) 
# """
# )

# Commit the change
client.query("COMMIT")
client.query("CHANGE SUBMIT")

# Checkout back to main
client.checkout()

# Query graph
client.query("MATCH (n) RETURN n")

# def main():
#     print("Hello from edth!")


# if __name__ == "__main__":
#     main()







